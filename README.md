# Douglas & Juliana - Landing Page de Upload de Fotos

Landing page moderna e delicada para os convidados enviarem fotos do casamento para um album no Google Drive, sem expor credenciais no front-end.

## Arquitetura (segura e barata)

- Front-end estatico em `public/`.
- Endpoint serverless em `api/upload.js`.
- Endpoint serverless em `api/validate-guest.js` para validar o nome do convidado.
- Upload feito no back-end usando OAuth de usuario (recomendado para conta Google pessoal) ou Service Account.
- Cada convidado recebe uma pasta propria no Google Drive, no formato `NOME_SOBRENOME`.
- Credenciais ficam apenas em variaveis de ambiente na plataforma de deploy.

## Estrutura

- `public/index.html`: landing page.
- `public/styles.css`: visual moderno, delicado e responsivo.
- `public/script.js`: slideshow, validacao do convidado e envio do formulario.
- `api/validate-guest.js`: valida nome e sobrenome na lista de convidados.
- `api/upload.js`: revalida o convidado, cria a pasta do convidado e envia os arquivos para o Google Drive.

## Requisitos

- Node.js 18+.
- Conta no Google Cloud com API do Google Drive habilitada.
- Pasta destino no Google Drive.
- Arquivo `.txt` com a lista de convidados salvo no Google Drive.

## Modo de autenticacao do Drive

O projeto suporta dois modos:

- `oauth` (recomendado para conta Google pessoal / Meu Drive).
- `service_account` (requer Shared Drive para upload).

Defina em `GOOGLE_AUTH_MODE`.

## Configuracao recomendada (OAuth de usuario)

Use este modo quando voce nao tem acesso a Shared Drive (apenas "Compartilhados comigo").

1. No Google Cloud, abra o projeto e ative a Google Drive API.
2. Crie uma credencial do tipo `OAuth client ID` (Web application).
3. Em `Authorized redirect URIs`, adicione:
  - `https://developers.google.com/oauthplayground`
4. No OAuth Playground:
  - Clique na engrenagem (canto superior direito) e marque `Use your own OAuth credentials`.
  - Informe seu `client_id` e `client_secret`.
  - No escopo, selecione `https://www.googleapis.com/auth/drive`.
  - Clique em `Authorize APIs` e depois `Exchange authorization code for tokens`.
  - Copie o `refresh_token`.
5. Preencha no `.env`:
  - `GOOGLE_AUTH_MODE=oauth`
  - `GOOGLE_OAUTH_CLIENT_ID=...`
  - `GOOGLE_OAUTH_CLIENT_SECRET=...`
  - `GOOGLE_OAUTH_REFRESH_TOKEN=...`
  - `GOOGLE_DRIVE_FOLDER_ID=...`
  - `GUEST_LIST_FILE_ID=...`

## Configuracao alternativa (Service Account)

## Configuracao do Google Drive (seguro)

1. Crie um projeto no Google Cloud.
2. Ative a API do Google Drive.
3. Crie uma Service Account.
4. Gere uma chave JSON da Service Account.
5. Compartilhe a pasta do Google Drive com o e-mail da Service Account (permissao de editor).
6. Envie para o Google Drive um arquivo `.txt` com um convidado por linha e compartilhe esse arquivo com a mesma Service Account.

## Variaveis de ambiente

Use o arquivo `.env.example` como base:

- `GOOGLE_AUTH_MODE`: `oauth` ou `service_account`.
- `GOOGLE_OAUTH_CLIENT_ID`: client id do OAuth (modo `oauth`).
- `GOOGLE_OAUTH_CLIENT_SECRET`: client secret do OAuth (modo `oauth`).
- `GOOGLE_OAUTH_REFRESH_TOKEN`: refresh token do OAuth (modo `oauth`).
- `GOOGLE_CLIENT_EMAIL`: e-mail da Service Account (modo `service_account`).
- `GOOGLE_PRIVATE_KEY_b64`: chave privada da Service Account codificada em base64 (modo `service_account`).
- `GOOGLE_DRIVE_FOLDER_ID`: ID da pasta no Drive.
- `GUEST_LIST_FILE_ID`: ID do arquivo `.txt` da lista de convidados no Drive.
- `GALLERY_USER`: usuario da area privada da galeria.
- `GALLERY_PASSWORD`: senha da area privada da galeria.
- `AUTH_TOKEN_SECRET`: segredo usado para assinar a sessao da galeria.
- `AUTH_TOKEN_TTL_SECONDS`: duracao do token de sessao em segundos.
- `UPLOAD_MAX_FILES`: quantidade maxima por envio (padrao 10).
- `UPLOAD_MAX_SIZE_MB`: tamanho maximo por arquivo em MB (padrao 15).
- `ALLOWED_ORIGINS`: lista de origens permitidas, separadas por virgula (ex.: `https://seu-dominio.com`).
- `UPLOAD_API_BASE_URL`: URL base opcional de um backend externo para uploads multipart, como um servico no Cloud Run.

### Como configurar no `.env` e no GitHub

No ambiente local, a aplicacao le tudo do arquivo `.env`.

No deploy via GitHub Actions + Cloud Run, a workflow le:

- `vars.*` para configuracoes nao sensiveis.
- `secrets.*` para credenciais e segredos.

Tabela sugerida:

| Variavel na aplicacao | Colocar no `.env` local | No GitHub Actions | Como obter |
| --- | --- | --- | --- |
| `GOOGLE_AUTH_MODE` | Sim | `Variable` | Defina `oauth` para conta Google pessoal / Meu Drive, ou `service_account` para Shared Drive. |
| `GOOGLE_DRIVE_FOLDER_ID` | Sim | `Variable` | ID da pasta de destino no Google Drive. Pode colar o link inteiro; a aplicacao extrai o ID. |
| `GUEST_LIST_FILE_ID` | Sim | `Variable` | ID do arquivo `.txt` com a lista de convidados no Google Drive. Pode colar o link inteiro; a aplicacao extrai o ID. |
| `AUTH_TOKEN_TTL_SECONDS` | Opcional | `Variable` | Tempo de sessao da galeria em segundos. Padrao: `2592000`. |
| `UPLOAD_MAX_FILES` | Opcional | `Variable` | Limite de arquivos por envio. Padrao: `10`. |
| `UPLOAD_MAX_SIZE_MB` | Opcional | `Variable` | Limite de tamanho por arquivo em MB. Padrao: `15`. |
| `SLIDE_INTERVAL_MS` | Opcional | `Variable` | Intervalo do slideshow em milissegundos. Padrao: `2000`. |
| `FIRST_SLIDE_DELAY_MS` | Opcional | `Variable` | Atraso inicial do slideshow em milissegundos. Padrao: `5000`. |
| `ALLOWED_ORIGINS` | Opcional | `Variable` | Dominios permitidos, separados por virgula. Ex.: `https://seu-dominio.com,https://www.seu-dominio.com`. |
| `GALLERY_USER` | Sim | `Secret` | Usuario definido por voce para acessar a galeria privada. |
| `GALLERY_PASSWORD` | Sim | `Secret` | Senha definida por voce para acessar a galeria privada. |
| `AUTH_TOKEN_SECRET` | Sim | `Secret` | Segredo aleatorio usado para assinar a sessao da galeria. Gere com um password manager ou `openssl rand -base64 32`. |
| `GOOGLE_OAUTH_CLIENT_ID` | Se `GOOGLE_AUTH_MODE=oauth` | `Secret` | Criado no Google Cloud em `APIs e Servicos` > `Credentials` > `OAuth client ID`. |
| `GOOGLE_OAUTH_CLIENT_SECRET` | Se `GOOGLE_AUTH_MODE=oauth` | `Secret` | Gerado junto com o `OAuth client ID` no Google Cloud. |
| `GOOGLE_OAUTH_REFRESH_TOKEN` | Se `GOOGLE_AUTH_MODE=oauth` | `Secret` | Gerado no OAuth Playground usando o escopo `https://www.googleapis.com/auth/drive`. |
| `GOOGLE_CLIENT_EMAIL` | Se `GOOGLE_AUTH_MODE=service_account` | `Secret` | Campo `client_email` do JSON da Service Account. |
| `GOOGLE_PRIVATE_KEY_b64` | Se `GOOGLE_AUTH_MODE=service_account` | `Secret` | Campo `private_key` do JSON da Service Account convertido para base64. |

Infra do deploy no GitHub Actions:

| Variavel da pipeline | No GitHub Actions | Como obter | Link / onde achar |
| --- | --- | --- | --- |
| `GCP_PROJECT_ID` | `Variable` | No Google Cloud Console, selecione o projeto no topo da tela e copie o `Project ID`. | Google Cloud Console: <https://console.cloud.google.com/home/dashboard> |
| `GCP_REGION` | `Variable` | Use a mesma regiao onde o servico sera criado no Cloud Run. Se o servico ja existir, abra `Cloud Run` e veja a coluna `Region`. Ex.: `southamerica-east1`. | Cloud Run setup: <https://cloud.google.com/run/docs/setup> |
| `CLOUD_RUN_SERVICE` | `Variable` | Nome do servico no Cloud Run. Se ainda nao existir, voce escolhe esse nome no primeiro deploy. Se ja existir, abra `Cloud Run` e copie o nome do servico. | Cloud Run console: <https://console.cloud.google.com/run> |
| `GCP_ARTIFACT_REPOSITORY` | `Variable` | Nome do repositorio Docker no Artifact Registry. Se ja existir, abra `Artifact Registry` e copie o nome. Se nao existir, defina um nome como `cloud-run-images`. | Artifact Registry console: <https://console.cloud.google.com/artifacts> |
| `GCP_WORKLOAD_IDENTITY_PROVIDER` | `Secret` | No Google Cloud, crie ou abra o Workload Identity Provider usado pelo GitHub Actions e copie o resource name no formato `projects/PROJECT_NUMBER/locations/global/workloadIdentityPools/POOL_ID/providers/PROVIDER_ID`. | Workload Identity Federation: <https://cloud.google.com/iam/docs/workload-identity-federation> |
| `GCP_SERVICE_ACCOUNT` | `Secret` | E-mail da service account usada pelo deploy. No Google Cloud Console: `IAM e administrador` > `Service Accounts` e copie o e-mail. | Service Accounts console: <https://console.cloud.google.com/iam-admin/serviceaccounts> |

Passo a passo para cadastrar no GitHub:

1. Abra o repositorio no GitHub.
2. Va em `Settings` > `Secrets and variables` > `Actions`.
3. Cadastre cada valor em `Variables` ou `Secrets`, conforme a tabela acima.
4. Como esta workflow usa `environment: production`, revise tambem `Settings` > `Environments` > `production`.

Links oficiais do GitHub:

- Variables: <https://docs.github.com/actions/how-tos/writing-workflows/choosing-what-your-workflow-does/store-information-in-variables>
- Secrets: <https://docs.github.com/en/actions/how-tos/administering-github-actions/sharing-workflows-secrets-and-runners-with-your-organization>

Importante:

- Nunca commite `.env`.
- Em plataformas como Vercel, cadastre as variaveis no painel do projeto.
- A `GOOGLE_PRIVATE_KEY_b64` deve conter a chave privada inteira convertida para base64.
- No modo `oauth`, nao use credenciais de Service Account.
- Em `GitHub` > `Settings` > `Secrets and variables` > `Actions`, cadastre os valores em `Variables` ou `Secrets`.
- Se a workflow usar `environment: production`, revise tambem `Settings` > `Environments` > `production`.

Exemplo para gerar a chave em base64 localmente:

```bash
python - <<'PY'
import base64
import json
from pathlib import Path

service_account = json.loads(Path('service-account.json').read_text())
private_key = service_account['private_key']
print(base64.b64encode(private_key.encode()).decode())
PY
```

O arquivo de convidados deve ter um nome completo por linha, por exemplo:

```text
Maria Silva
Joao Pereira
Fernanda Costa
```

## Rodando localmente

1. Instale dependencias:

```bash
npm install
```

2. Instale Vercel CLI (uma vez):

```bash
npm i -g vercel
```

3. Inicie local:

```bash
npm run dev
```

4. Se quiser simular especificamente o ambiente da Vercel:

```bash
npm run dev:vercel
```

## Teste local com Docker

1. Build da imagem:

```bash
docker build -t casamento-dougrax-ju .
```

2. Execute o container (carregando variaveis do `.env`):

```bash
docker run --rm -p 3000:3000 --env-file .env casamento-dougrax-ju
```

3. Acesse em:

```text
http://localhost:3000
```

## Teste local com Docker Compose

1. Suba o ambiente:

```bash
docker compose up --build
```

2. Acesse em:

```text
http://localhost:3000
```

3. Para encerrar:

```bash
docker compose down
```

Observacao:

- O fluxo local com `npm run dev`, Docker e Docker Compose nao exige `vercel login`.
- O deploy continua compativel com a Vercel, usando `api/upload.js` como funcao serverless.


## Deploy no Cloud Run com GitHub Actions

O repositrio agora pode fazer deploy automatico no Google Cloud Run usando a workflow em `.github/workflows/deploy-cloud-run.yml`.

### Migracao recomendada do upload para fora da Vercel

Para contornar instabilidades de upload multipart no celular, a migracao recomendada e:

- manter o site e as rotas leves na Vercel;
- publicar o backend de upload no Cloud Run;
- configurar a Vercel para apontar os uploads para a URL do Cloud Run via `UPLOAD_API_BASE_URL`.

Com isso:

- a home, a galeria, o login e `/api/config` continuam servidos pela Vercel;
- `POST /api/upload` e `POST /api/challenge-upload` passam a sair do front-end direto para o Cloud Run;
- o limite e o comportamento de upload deixam de depender da Function multipart da Vercel.

### Passo final na Vercel

Depois que o Cloud Run estiver publicado, abra o projeto na Vercel e configure:

- `UPLOAD_API_BASE_URL=https://SEU-SERVICO-DO-CLOUD-RUN`

Exemplo:

```text
UPLOAD_API_BASE_URL=https://casamento-dougrax-ju-abc123-ue.a.run.app
```

Depois disso, faca um novo deploy da Vercel. O front-end ja esta preparado para:

- usar `/api/upload` local quando `UPLOAD_API_BASE_URL` estiver vazio;
- usar `https://SEU-SERVICO-DO-CLOUD-RUN/api/upload` quando a variavel estiver preenchida.

O mesmo vale para:

- `/api/challenge-upload`

### 1. Criar a autenticacao do GitHub com o Google Cloud

Recomenda-se usar Workload Identity Federation, sem chave JSON fixa no GitHub.

Voce vai precisar destes valores no GitHub:

- `secrets.GCP_WORKLOAD_IDENTITY_PROVIDER`: provider no formato `projects/123456789/locations/global/workloadIdentityPools/github/providers/actions`.
- `secrets.GCP_SERVICE_ACCOUNT`: e-mail da service account usada pelo deploy.
- `vars.GCP_PROJECT_ID`: ID do projeto no Google Cloud.
- `vars.GCP_REGION`: regiao do Cloud Run. Exemplo: `southamerica-east1`.
- `vars.CLOUD_RUN_SERVICE`: nome do servico. Exemplo: `casamento-dougrax-ju`.
- `vars.GCP_ARTIFACT_REPOSITORY`: repositorio Docker do Artifact Registry. Exemplo: `cloud-run-images`.

Permissoes minimas da service account de deploy:

- `roles/run.admin`
- `roles/iam.serviceAccountUser`
- `roles/artifactregistry.admin` na primeira execucao, ou `roles/artifactregistry.writer` se o repositorio ja existir
- `roles/cloudbuild.builds.editor` se voce optar por usar Cloud Build em outros fluxos

### 2. Configurar variaveis e secrets da aplicacao no GitHub

Variables sugeridas:

- `GOOGLE_AUTH_MODE`
- `GOOGLE_DRIVE_FOLDER_ID`
- `GUEST_LIST_FILE_ID`
- `AUTH_TOKEN_TTL_SECONDS`
- `UPLOAD_MAX_FILES`
- `UPLOAD_MAX_SIZE_MB`
- `SLIDE_INTERVAL_MS`
- `FIRST_SLIDE_DELAY_MS`
- `ALLOWED_ORIGINS`

Secrets sugeridos:

- `GALLERY_USER`
- `GALLERY_PASSWORD`
- `AUTH_TOKEN_SECRET`
- `GOOGLE_OAUTH_CLIENT_ID`
- `GOOGLE_OAUTH_CLIENT_SECRET`
- `GOOGLE_OAUTH_REFRESH_TOKEN`
- `GOOGLE_CLIENT_EMAIL`
- `GOOGLE_PRIVATE_KEY_B64`

Observacao:

- Se voce usar `oauth`, os secrets de OAuth precisam estar preenchidos.
- Se voce usar `service_account`, os secrets `GOOGLE_CLIENT_EMAIL` e `GOOGLE_PRIVATE_KEY_B64` precisam estar preenchidos.

### 3. Disparar o deploy

O deploy acontece em push para `main` e tambem pode ser executado manualmente pelo `workflow_dispatch`.

Ao final, a action publica a imagem no Artifact Registry e atualiza o servico do Cloud Run.

### 4. Configurar dominio personalizado

Depois do primeiro deploy:

1. Abra Cloud Run no Google Cloud Console.
2. Entre no servico publicado.
3. Use `Manage Custom Domains`.
4. Aponte o DNS do seu dominio para os registros entregues pelo Google.

Para um dominio como `www.casamento-douglas-juliana.com.br`, o DNS e configurado no provedor onde o dominio foi registrado, por exemplo Registro.br, e nao no GitHub.

## Deploy recomendado (menor custo)

### Melhor estrategia

Para o seu caso (landing page + upload simples e seguro), a melhor combinacao e:

- Vercel (plano Hobby) para front-end + funcao serverless.
- Google Drive API com OAuth de usuario (ou Service Account em Shared Drive).

Por que:

- Zero custo inicial na maioria dos casos pequenos.
- Deploy muito rapido.
- Secrets seguros no painel da Vercel.
- Escala automatica sem manter servidor ligado.

### Custo aproximado

Cenario comum para casamento (volume moderado de convidados):

- Vercel Hobby: R$ 0/mes.
- Google Drive API: R$ 0 dentro de cotas usuais.
- Armazenamento no Google Drive: depende do plano da conta proprietaria.
  - 15 GB gratuitos (conta Google pessoal).
  - Google One 100 GB: cerca de R$ 10 a R$ 15/mes.

Resumo pratico:

- Custo total esperado: entre R$ 0 e R$ 15/mes, dependendo apenas do espaco usado no Drive.

## Reforcos de seguranca implementados

- Credenciais usadas apenas no back-end.
- Lista de convidados consultada no back-end, sem expor o arquivo do Drive no navegador.
- Validacao de origem (`ALLOWED_ORIGINS`).
- Validacao de tipo MIME de imagem.
- Limites de quantidade e tamanho de arquivos.
- Nome do convidado revalidado no upload para impedir bypass do modal.
- Uploads separados automaticamente por pasta de convidado (`NOME_SOBRENOME`).
- Nomes de arquivo higienizados antes do upload.

## Melhorias opcionais

- Adicionar Cloudflare Turnstile para reduzir spam.
- Registrar logs de tentativas de abuso.
- Criar subpastas por data ou por convidado.
