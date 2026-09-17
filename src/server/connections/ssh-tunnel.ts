import { Client } from "ssh2";
import { createServer, type Server } from "node:net";
import { decryptSecret } from "@/server/security/crypto";
import { ApiError } from "@/server/http";

export type SshTunnelConnection = {
  sshTunnelEnabled?: boolean;
  sshHost?: string | null;
  sshPort?: number | null;
  sshUsername?: string | null;
  sshAuthMethod?: string | null;
  sshEncryptedSecret?: string | null;
};

type SshSecret = { password?: string; privateKey?: string; passphrase?: string };

export type OpenTunnelResult = { host: string; port: number; close: () => Promise<void> };

/**
 * Se a conexao tiver tunel SSH habilitado, abre um forward local (porta efemera na
 * maquina do Catworld -> host:port do banco, visto do lado do host SSH) e retorna o
 * endereco local a usar no lugar de connection.server/connection.port. Caso contrario,
 * retorna o proprio host/port da conexao sem abrir nada.
 */
export async function resolveEffectiveTarget(
  connection: SshTunnelConnection & { server: string; port: number | null },
  defaultPort: number,
): Promise<OpenTunnelResult> {
  if (!connection.sshTunnelEnabled) {
    return { host: connection.server, port: connection.port ?? defaultPort, close: async () => undefined };
  }
  if (!connection.sshHost || !connection.sshUsername || !connection.sshEncryptedSecret) {
    throw new ApiError(400, "SSH_TUNNEL_MISCONFIGURED", "Tunel SSH habilitado sem host/usuario/segredo configurados");
  }
  const secret = JSON.parse(decryptSecret(connection.sshEncryptedSecret)) as SshSecret;

  const sshClient = new Client();
  const localServer = await new Promise<Server>((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server));
  });

  await new Promise<void>((resolve, reject) => {
    sshClient.on("ready", resolve);
    sshClient.on("error", (err) => reject(new ApiError(502, "SSH_TUNNEL_FAILED", `Falha ao conectar no host SSH: ${err.message}`)));
    sshClient.connect({
      host: connection.sshHost!,
      port: connection.sshPort ?? 22,
      username: connection.sshUsername!,
      password: connection.sshAuthMethod === "password" ? secret.password : undefined,
      privateKey: connection.sshAuthMethod === "privateKey" ? secret.privateKey : undefined,
      passphrase: connection.sshAuthMethod === "privateKey" ? secret.passphrase : undefined,
      readyTimeout: 10000,
    });
  });

  localServer.on("connection", (socket) => {
    sshClient.forwardOut(
      socket.remoteAddress ?? "127.0.0.1",
      socket.remotePort ?? 0,
      connection.server,
      connection.port ?? defaultPort,
      (err, stream) => {
        if (err || !stream) { socket.destroy(); return; }
        socket.pipe(stream).pipe(socket);
      },
    );
  });

  const address = localServer.address();
  const localPort = typeof address === "object" && address ? address.port : 0;

  const close = async () => {
    await new Promise<void>((resolve) => localServer.close(() => resolve()));
    sshClient.end();
  };

  return { host: "127.0.0.1", port: localPort, close };
}

/** Serializa o segredo do tunel (senha ou chave privada) para armazenamento cifrado */
export function serializeSshSecret(input: { authMethod: "password" | "privateKey"; password?: string; privateKey?: string; passphrase?: string }): SshSecret {
  return input.authMethod === "password"
    ? { password: input.password }
    : { privateKey: input.privateKey, passphrase: input.passphrase };
}
