import { describe, expect, it } from "vitest";
import { maskConnectionString } from "./mask-url";

describe("maskConnectionString", () => {
  it("mascara password= (ADO/ODBC) sem mexer no resto", () => {
    expect(maskConnectionString("Server=x;Database=d;User Id=u;Password=abc123;Encrypt=true")).toBe("Server=x;Database=d;User Id=u;Password=••••••••;Encrypt=true");
  });
  it("mascara senha no formato URL postgres://usuario:senha@host", () => {
    expect(maskConnectionString("postgres://internal77:s3nh4@host:5432/db")).toBe("postgres://internal77:••••••••@host:5432/db");
    expect(maskConnectionString("postgres://u:p%40ss@h/db?sslmode=require")).not.toContain("p%40ss");
  });
  it("mascara password na query string e pwd=", () => {
    expect(maskConnectionString("postgres://h/db?user=u&password=segredo&sslmode=x")).toBe("postgres://h/db?user=u&password=••••••••&sslmode=x");
    expect(maskConnectionString("pwd=abc;x=1")).toBe("pwd=••••••••;x=1");
  });
  it("vazio vira travessao e URL sem credencial fica intacta", () => {
    expect(maskConnectionString(null)).toBe("—");
    expect(maskConnectionString("postgres://host:5432/db")).toBe("postgres://host:5432/db");
  });
});
