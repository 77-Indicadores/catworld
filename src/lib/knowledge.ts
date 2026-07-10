export type Section =
  | { kind: "text"; text: string }
  | { kind: "steps"; items: string[] }
  | { kind: "list"; items: string[] }
  | { kind: "note"; variant: "info" | "warning" | "tip" | "danger"; text: string }
  | { kind: "code"; label?: string; value: string }
  | { kind: "heading"; text: string }
  | { kind: "table"; headers: string[]; rows: string[][] };

export type Article = {
  slug: string;
  title: string;
  description: string;
  category: string;
  icon: string;
  sections: Section[];
};

export const categories = [
  { key: "primeiros-passos", label: "Primeiros passos" },
  { key: "conectividade", label: "Conectividade e integração" },
  { key: "dados", label: "Dados e uploads" },
  { key: "seguranca", label: "Segurança e acessos" },
];

export const articles: Article[] = [
  // ── PRIMEIROS PASSOS ─────────────────────────────────────────────────
  {
    slug: "visao-geral",
    title: "O que é o Catworld?",
    description: "Entenda o propósito da plataforma, como ela está organizada e quais problemas ela resolve.",
    category: "primeiros-passos",
    icon: "BookOpen",
    sections: [
      {
        kind: "text",
        text: "O Catworld é um data lake corporativo que centraliza dados de diferentes origens em um único lugar seguro, catalogado e consultável. Ele elimina a necessidade de múltiplos silos de dados e planilhas avulsas, permitindo que equipes de BI, análise e desenvolvimento acessem dados estruturados com controle de acesso granular.",
      },
      { kind: "heading", text: "Como o Catworld está organizado" },
      {
        kind: "table",
        headers: ["Conceito", "O que é"],
        rows: [
          ["Projeto", "Agrupamento lógico de datasets relacionados a um mesmo domínio (ex: Financeiro, Vendas)"],
          ["Dataset", "Conjunto de tabelas dentro de um projeto. Cada dataset tem seu próprio schema no banco."],
          ["Tabela", "Tabela física de dados, criada por upload de arquivo ou sincronizada de uma fonte externa."],
          ["Fonte conectada", "Conexão com um banco Postgres externo que alimenta tabelas por extração ou consulta ao vivo."],
        ],
      },
      { kind: "heading", text: "Fluxo típico de uso" },
      {
        kind: "steps",
        items: [
          "Crie um Projeto para o seu domínio de dados",
          "Adicione um ou mais Datasets dentro do projeto",
          "Popule as tabelas via upload de CSV/Excel ou conecte uma fonte Postgres",
          "Crie Tokens de API para que ferramentas como Power BI, scripts Python ou dashboards acessem os dados",
          "Gerencie permissões por usuário, token ou usuário de banco direto",
        ],
      },
      {
        kind: "note",
        variant: "info",
        text: "O Catworld usa Azure SQL Server como motor de armazenamento. Todos os dados são criptografados em trânsito e em repouso.",
      },
    ],
  },
  {
    slug: "projetos-e-datasets",
    title: "Projetos e Datasets",
    description: "Como criar e organizar projetos, datasets e tabelas no Catworld.",
    category: "primeiros-passos",
    icon: "FolderKanban",
    sections: [
      { kind: "heading", text: "Projetos" },
      {
        kind: "text",
        text: "Projetos são o nível mais alto de organização. Cada projeto representa um domínio de negócio (ex: Financeiro, RH, Operações). Todo acesso a dados é concedido no nível de projeto ou dataset.",
      },
      {
        kind: "steps",
        items: [
          "Acesse Projetos na barra lateral",
          'Clique em "Novo projeto" e preencha nome e descrição',
          "O projeto é criado com um slug automático usado nas URLs e na API",
        ],
      },
      { kind: "heading", text: "Datasets" },
      {
        kind: "text",
        text: "Um dataset é um conjunto de tabelas relacionadas dentro de um projeto. Cada dataset corresponde a um schema isolado no Azure SQL, garantindo que os dados de diferentes datasets não se misturem.",
      },
      {
        kind: "steps",
        items: [
          "Abra um projeto e clique em um dataset na barra lateral esquerda",
          'Clique em "Novo dataset" na barra lateral',
          "Defina nome e descrição. O schema SQL é criado automaticamente.",
        ],
      },
      { kind: "heading", text: "Tabelas" },
      {
        kind: "text",
        text: "Tabelas são criadas de duas formas: por upload de arquivo (CSV/Excel) ou por fonte conectada (Postgres). Uma tabela criada por upload é uma cópia materializada dos dados. Uma tabela de fonte conectada pode ser uma cópia atualizada periodicamente ou uma consulta ao vivo.",
      },
      {
        kind: "note",
        variant: "tip",
        text: "Use uploads para dados históricos ou planilhas consolidadas. Use fontes conectadas para dados que mudam frequentemente em um banco operacional.",
      },
    ],
  },
  // ── CONECTIVIDADE ────────────────────────────────────────────────────
  {
    slug: "tokens-de-api",
    title: "Tokens de API",
    description: "Como criar, usar e revogar tokens para acessar a API e os dados do Catworld de forma segura.",
    category: "conectividade",
    icon: "KeyRound",
    sections: [
      {
        kind: "text",
        text: "Tokens de API são credenciais que permitem a ferramentas externas (Power BI, Python, dashboards) acessar dados do Catworld sem expor a senha do usuário. Cada token tem escopo e permissão definidos e pode ser revogado a qualquer momento.",
      },
      { kind: "heading", text: "Criando um token" },
      {
        kind: "steps",
        items: [
          'Acesse Tokens na barra lateral e clique em "Novo token"',
          "Dê um nome descritivo que identifique o uso (ex: Power BI Vendas)",
          "Selecione o escopo: Global, Projeto específico ou Dataset específico",
          "Escolha a permissão: Leitura (recomendado para BI) ou Escrita",
          "Defina uma data de expiração opcional",
          "Copie o token gerado — ele não será exibido novamente",
        ],
      },
      { kind: "heading", text: "Como usar o token na API" },
      {
        kind: "code",
        label: "Header HTTP",
        value: "Authorization: Bearer cw_live_xxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      },
      {
        kind: "code",
        label: "curl",
        value: 'curl https://app.catworld.com/api/v1/queries \\\n  -H "Authorization: Bearer cw_live_xxx" \\\n  -H "Content-Type: application/json" \\\n  -d \'{"sql": "SELECT * FROM vendas LIMIT 10", "datasetId": "..."}\'',
      },
      { kind: "heading", text: "Boas práticas" },
      {
        kind: "list",
        items: [
          "Crie um token separado por integração (um para Power BI, outro para Python, etc.)",
          "Use sempre o menor escopo necessário — prefira Dataset ao invés de Global",
          "Defina datas de expiração para tokens de acesso temporário",
          "Revogue imediatamente tokens que foram expostos ou não são mais necessários",
          "Nunca commite tokens em repositórios de código. Use variáveis de ambiente.",
        ],
      },
      {
        kind: "note",
        variant: "warning",
        text: "Um token com permissão Global de Leitura tem acesso a todos os dados da plataforma. Use com cautela.",
      },
    ],
  },
  {
    slug: "powerbi-desktop",
    title: "Conectar ao Power BI Desktop",
    description: "Passo a passo para conectar o Power BI Desktop aos dados do Catworld via OData.",
    category: "conectividade",
    icon: "BarChart2",
    sections: [
      {
        kind: "text",
        text: "O Catworld expõe os dados de cada dataset como um endpoint OData v4. O Power BI Desktop tem suporte nativo a OData, então a conexão é direta — sem instalar drivers ou extensões.",
      },
      { kind: "heading", text: "URL do endpoint OData" },
      {
        kind: "text",
        text: "Cada dataset tem uma URL OData única no formato:",
      },
      {
        kind: "code",
        value: "https://app.catworld.com/api/odata/{slug-do-projeto}/{slug-do-dataset}",
      },
      {
        kind: "text",
        text: "Você encontra essa URL clicando no botão 'Conectar ao Power BI' dentro de qualquer dataset.",
      },
      { kind: "heading", text: "Passo a passo" },
      {
        kind: "steps",
        items: [
          "Abra o Power BI Desktop",
          'Clique em "Obter dados" → pesquise "OData" → selecione "Feed OData"',
          "Cole a URL do dataset e clique em OK",
          'Na tela de autenticação, escolha "Básica"',
          'No campo "Nome de usuário", coloque qualquer texto (ex: token)',
          'No campo "Senha", cole seu token de API do Catworld',
          "Clique em Conectar",
          "Selecione as tabelas que deseja importar e clique em Carregar",
        ],
      },
      { kind: "heading", text: "O que cada tabela expõe" },
      {
        kind: "text",
        text: "O endpoint OData lista automaticamente todas as tabelas do dataset, com os tipos de coluna corretos (texto, número, data, etc.). Nenhuma configuração adicional é necessária.",
      },
      {
        kind: "note",
        variant: "warning",
        text: "Para publicar o relatório no Power BI Service com atualização agendada, siga o guia específico 'Conectar ao Power BI Service' — a autenticação é diferente.",
      },
      { kind: "heading", text: "Parâmetros OData suportados" },
      {
        kind: "table",
        headers: ["Parâmetro", "Descrição", "Padrão"],
        rows: [
          ["$top", "Número máximo de linhas retornadas", "1.000 (máx 10.000)"],
          ["$skip", "Linhas para pular (paginação)", "0"],
          ["$select", "Colunas específicas (ex: nome,valor)", "todas"],
          ["$count=true", "Inclui total de linhas na resposta", "não incluído"],
        ],
      },
    ],
  },
  {
    slug: "powerbi-service",
    title: "Conectar ao Power BI Service (refresh agendado)",
    description: "Como configurar o Power BI Service para atualizar dados do Catworld automaticamente, sem gateway.",
    category: "conectividade",
    icon: "Cloud",
    sections: [
      {
        kind: "text",
        text: "O Power BI Service suporta autenticação Básica com o Catworld — funciona para refresh agendado sem necessidade de gateway.",
      },
      { kind: "heading", text: "Passo a passo" },
      {
        kind: "steps",
        items: [
          "No Power BI Desktop, vá em Obter dados → Feed OData",
          "Cole a URL base do dataset (sem token): https://catworld.77indicadores.com.br/api/odata/{projeto}/{dataset}",
          "Na autenticação, selecione Básica. Usuário: qualquer texto (ex: token). Senha: seu token de API",
          "Importe as tabelas, monte o relatório e publique no Power BI Service",
          "No Service: Configurações do dataset → Credenciais da fonte de dados → Editar credenciais",
          "Selecione Básica e informe novamente usuário e token",
          "Ative Atualização agendada — funciona sem gateway",
        ],
      },
      { kind: "heading", text: "Preciso de um gateway?" },
      {
        kind: "text",
        text: "Não. O Catworld é acessível pela internet via HTTPS, então o Power BI Service acessa diretamente. Gateways só são necessários para fontes dentro de redes privadas.",
      },
    ],
  },
  {
    slug: "api-odata",
    title: "Usando a API OData",
    description: "Referência completa da API OData do Catworld: endpoints, autenticação, paginação e filtros.",
    category: "conectividade",
    icon: "Webhook",
    sections: [
      {
        kind: "text",
        text: "A API OData v4 do Catworld permite que qualquer ferramenta compatível com OData (Power BI, Excel, Tableau, etc.) consuma dados de datasets sem precisar de SQL. Também pode ser usada diretamente via HTTP por scripts e aplicações.",
      },
      { kind: "heading", text: "Endpoints" },
      {
        kind: "table",
        headers: ["Método", "URL", "Descrição"],
        rows: [
          ["GET", "/api/odata/{projeto}/{dataset}", "Service Document — lista tabelas disponíveis"],
          ["GET", "/api/odata/{projeto}/{dataset}/$metadata", "Esquema EDMX com tipos de todas as colunas"],
          ["GET", "/api/odata/{projeto}/{dataset}/{tabela}", "Dados da tabela com suporte a query options"],
        ],
      },
      { kind: "heading", text: "Autenticação" },
      {
        kind: "table",
        headers: ["Método", "Como usar", "Indicado para"],
        rows: [
          ["Bearer token", "Authorization: Bearer cw_live_xxx", "API, scripts, Power BI Desktop"],
          ["Basic auth", "Usuário: qualquer / Senha: token", "Power BI Desktop e Service"],
          ["Query param", "?api_key=cw_live_xxx na URL", "Scripts e integrações HTTP"],
        ],
      },
      { kind: "heading", text: "Query options suportadas" },
      {
        kind: "code",
        label: "Exemplo — paginação",
        value: "GET /api/odata/vendas/2024/$metadata#pedidos?$top=500&$skip=1000",
      },
      {
        kind: "code",
        label: "Exemplo — colunas específicas",
        value: "GET /api/odata/vendas/2024/pedidos?$select=id,cliente,valor&$count=true",
      },
      { kind: "heading", text: "Formato da resposta" },
      {
        kind: "code",
        label: "JSON OData v4",
        value: `{
  "@odata.context": "https://app.catworld.com/api/odata/vendas/2024/$metadata#pedidos",
  "@odata.count": 15430,
  "value": [
    { "_row_number": 1, "id": "P001", "cliente": "Empresa X", "valor": 1500.00 },
    ...
  ],
  "@odata.nextLink": "...?$top=1000&$skip=1000"
}`,
      },
      {
        kind: "note",
        variant: "info",
        text: "O campo _row_number é uma chave sintética adicionada pelo Catworld para compatibilidade com o protocolo OData. Ele não existe na tabela original.",
      },
    ],
  },
  {
    slug: "api-rest",
    title: "API REST — Consultas SQL",
    description: "Execute consultas SQL diretamente pela API REST do Catworld com token de autenticação.",
    category: "conectividade",
    icon: "Code",
    sections: [
      {
        kind: "text",
        text: "Além do OData, o Catworld expõe uma API REST para executar consultas SQL diretamente. Útil para scripts Python, dashboards personalizados e integrações que precisam de SQL completo.",
      },
      { kind: "heading", text: "Executar uma consulta" },
      {
        kind: "code",
        label: "POST /api/v1/queries",
        value: `curl -X POST https://app.catworld.com/api/v1/queries \\
  -H "Authorization: Bearer cw_live_xxx" \\
  -H "Content-Type: application/json" \\
  -d '{
    "sql": "SELECT cliente, SUM(valor) as total FROM pedidos GROUP BY cliente",
    "datasetId": "uuid-do-dataset",
    "timeout": 30,
    "limit": 5000
  }'`,
      },
      { kind: "heading", text: "Parâmetros" },
      {
        kind: "table",
        headers: ["Campo", "Tipo", "Obrigatório", "Descrição"],
        rows: [
          ["sql", "string", "sim", "Consulta SELECT (somente leitura)"],
          ["datasetId", "uuid", "não*", "Restringe ao schema do dataset"],
          ["projectId", "uuid", "não*", "Permite referenciar tabelas de qualquer dataset do projeto"],
          ["timeout", "int", "não", "Timeout em segundos (1–120, padrão 30)"],
          ["limit", "int", "não", "Máximo de linhas (1–10.000, padrão 10.000)"],
        ],
      },
      {
        kind: "note",
        variant: "info",
        text: "*Forneça datasetId OU projectId para que nomes de tabela sem schema sejam resolvidos automaticamente. Sem eles, use nomes totalmente qualificados (schema.tabela).",
      },
      { kind: "heading", text: "Exportar como CSV ou Excel" },
      {
        kind: "code",
        label: "POST /api/v1/queries/export",
        value: `curl -X POST https://app.catworld.com/api/v1/queries/export \\
  -H "Authorization: Bearer cw_live_xxx" \\
  -H "Content-Type: application/json" \\
  -d '{"sql": "SELECT * FROM pedidos", "format": "csv"}' \\
  --output resultado.csv`,
      },
      {
        kind: "list",
        items: [
          "Formatos suportados: csv e xlsx",
          "CSV exportado com BOM UTF-8 para compatibilidade com Excel",
          "Excel inclui cabeçalho em negrito",
          "Limite de 10.000 linhas por exportação",
        ],
      },
    ],
  },
  // ── DADOS ────────────────────────────────────────────────────────────
  {
    slug: "upload-de-arquivos",
    title: "Upload de arquivos CSV e Excel",
    description: "Como enviar planilhas para criar e atualizar tabelas no Catworld.",
    category: "dados",
    icon: "UploadCloud",
    sections: [
      {
        kind: "text",
        text: "O upload de arquivos é a forma mais simples de inserir dados no Catworld. Suporta CSV, XLSX e XLS. Ao fazer upload, você pode criar uma nova tabela ou substituir/atualizar uma existente.",
      },
      { kind: "heading", text: "Modos de importação" },
      {
        kind: "table",
        headers: ["Modo", "O que faz", "Quando usar"],
        rows: [
          ["Substituição", "Apaga todos os dados e reinsere", "Planilhas que são enviadas completas toda vez"],
          ["Atualização (Upsert)", "Atualiza linhas existentes e insere novas", "Dados incrementais com chave única"],
        ],
      },
      { kind: "heading", text: "Passo a passo" },
      {
        kind: "steps",
        items: [
          "Abra um dataset e role até a seção Novo upload",
          "Arraste o arquivo ou clique para selecionar",
          "O Catworld detecta automaticamente colunas e tipos",
          "Revise o mapeamento de colunas e ajuste se necessário",
          "Selecione o modo (substituição ou upsert) e clique em Importar",
          "Aguarde a conclusão — o progresso é exibido em tempo real",
        ],
      },
      { kind: "heading", text: "Limites e formatos" },
      {
        kind: "list",
        items: [
          "Tamanho máximo por arquivo: configurado pelo administrador",
          "Formatos: .csv, .xlsx, .xls",
          "Tipos detectados automaticamente: texto, inteiro, decimal, data, booleano",
          "Datas são normalizadas para o formato ISO 8601",
          "Colunas com nomes duplicados são renomeadas automaticamente",
        ],
      },
      {
        kind: "note",
        variant: "tip",
        text: "Para grandes volumes de dados (acima de 100k linhas), considere usar uma Fonte Conectada ao invés de upload manual.",
      },
    ],
  },
  {
    slug: "fontes-conectadas",
    title: "Fontes conectadas (Postgres)",
    description: "Como sincronizar tabelas de um banco Postgres externo para o Catworld.",
    category: "dados",
    icon: "DatabaseZap",
    sections: [
      {
        kind: "text",
        text: "Fontes conectadas permitem que o Catworld extraia dados de bancos Postgres externos (produção, homologação ou staging) e os mantenha atualizados no data lake. Existem dois modos de operação: cópia (extração) e consulta ao vivo.",
      },
      { kind: "heading", text: "Modos de operação" },
      {
        kind: "table",
        headers: ["Modo", "Como funciona", "Quando usar"],
        rows: [
          ["Cópia (Extract)", "Copia os dados para o Catworld periodicamente", "Relatórios, snapshots, dados históricos"],
          ["Consulta ao vivo (Live)", "Consulta diretamente o banco de origem a cada query", "Dados que precisam ser sempre do momento atual"],
        ],
      },
      { kind: "heading", text: "Configurando uma conexão" },
      {
        kind: "steps",
        items: [
          "Acesse Configurações → Conexões e adicione as credenciais do banco Postgres",
          "Teste a conexão para confirmar que está acessível",
          "Abra um dataset e clique em Adicionar fonte",
          "Selecione a conexão, o schema e a tabela de origem (ou escreva uma consulta SQL)",
          "Escolha o modo (cópia ou ao vivo) e a política de atualização",
          "Salve — a primeira extração será iniciada automaticamente no modo cópia",
        ],
      },
      { kind: "heading", text: "Políticas de atualização (modo cópia)" },
      {
        kind: "list",
        items: [
          'Manual — atualiza apenas quando você clicar em "Atualizar agora"',
          "Horária — extrai a cada hora",
          "Diária — extrai uma vez por dia",
          "Semanal — extrai uma vez por semana",
        ],
      },
      {
        kind: "note",
        variant: "info",
        text: "No modo consulta ao vivo, nenhum dado é copiado. O Catworld redireciona a query para o banco de origem em tempo real. O desempenho depende da latência da conexão.",
      },
    ],
  },
  // ── SEGURANÇA ────────────────────────────────────────────────────────
  {
    slug: "permissoes-e-acessos",
    title: "Permissões e acessos",
    description: "Como funciona o modelo de permissões do Catworld: usuários, tokens e escopos.",
    category: "seguranca",
    icon: "ShieldCheck",
    sections: [
      {
        kind: "text",
        text: "O Catworld usa um modelo de permissões baseado em concessões (grants). Cada usuário, token ou usuário de banco pode ter acesso a Global, um Projeto específico ou um Dataset específico, com nível de permissão Leitura ou Escrita.",
      },
      { kind: "heading", text: "Tipos de principal" },
      {
        kind: "table",
        headers: ["Principal", "O que é", "Como autenticar"],
        rows: [
          ["Usuário", "Pessoa com login na plataforma", "Email + senha"],
          ["Token de API", "Credencial para integrações externas", "Authorization: Bearer"],
          ["Usuário de banco", "Login direto no Azure SQL", "SQL Server / ODBC"],
        ],
      },
      { kind: "heading", text: "Níveis de escopo" },
      {
        kind: "table",
        headers: ["Escopo", "Acesso"],
        rows: [
          ["Global", "Todos os projetos e datasets da plataforma"],
          ["Projeto", "Todos os datasets de um projeto específico"],
          ["Dataset", "Somente um dataset específico"],
        ],
      },
      { kind: "heading", text: "Permissões" },
      {
        kind: "table",
        headers: ["Permissão", "O que permite"],
        rows: [
          ["Leitura", "SELECT em todas as tabelas do escopo"],
          ["Escrita", "SELECT, INSERT, UPDATE, DELETE nas tabelas do escopo"],
          ["Administração", "Gerenciar usuários, tokens, datasets e projetos (somente usuários)"],
        ],
      },
      { kind: "heading", text: "Gerenciando permissões" },
      {
        kind: "steps",
        items: [
          "Acesse Usuários na barra lateral",
          "Clique em Gerenciar permissões do usuário desejado",
          "Adicione uma concessão com escopo e nível de permissão",
          "As permissões são aplicadas imediatamente na próxima query",
        ],
      },
      {
        kind: "note",
        variant: "tip",
        text: "Prefira sempre o menor escopo necessário. Um analista de vendas deve ter acesso somente ao dataset de Vendas, não ao projeto inteiro.",
      },
    ],
  },
  {
    slug: "usuarios-de-banco",
    title: "Usuários de banco (SQL direto)",
    description: "Como criar credenciais SQL para conectar ao Azure SQL diretamente via ODBC, Excel ou outras ferramentas.",
    category: "seguranca",
    icon: "FileKey2",
    sections: [
      {
        kind: "text",
        text: "Usuários de banco são credenciais SQL que permitem conexão direta ao Azure SQL Server do Catworld. São usados por ferramentas que suportam SQL Server nativo, como Excel (via ODBC), Power BI (Direct Query) ou aplicações legadas.",
      },
      { kind: "heading", text: "Quando usar usuários de banco vs. tokens de API" },
      {
        kind: "table",
        headers: ["Situação", "Use"],
        rows: [
          ["Power BI Desktop via OData", "Token de API"],
          ["Power BI Desktop via SQL Server direto", "Usuário de banco"],
          ["Excel via ODBC", "Usuário de banco"],
          ["Script Python / Node.js", "Token de API"],
          ["Power BI Service (refresh agendado sem gateway)", "Token de API + OData"],
        ],
      },
      { kind: "heading", text: "Criando um usuário de banco" },
      {
        kind: "steps",
        items: [
          'Acesse Usuários do banco na barra lateral e clique em "Novo usuário"',
          "Selecione o tipo (Power BI, Aplicação ou Analista)",
          "Defina o escopo e a permissão",
          "O Catworld cria o login no Azure SQL e exibe a senha — copie agora, não será exibida novamente",
        ],
      },
      { kind: "heading", text: "String de conexão" },
      {
        kind: "code",
        label: "ODBC / SQL Server",
        value: "Server=catworld.database.windows.net,1433;Database=catworld;User Id=<usuario>;Password=<senha>;Encrypt=True;",
      },
      {
        kind: "note",
        variant: "warning",
        text: "As senhas de usuários de banco podem ser rotacionadas a qualquer momento clicando em Rotacionar senha. Após a rotação, atualize a senha em todas as ferramentas que usam esse usuário.",
      },
    ],
  },
];

export function getArticle(slug: string) {
  return articles.find((a) => a.slug === slug) ?? null;
}

export function getArticlesByCategory(category: string) {
  return articles.filter((a) => a.category === category);
}
