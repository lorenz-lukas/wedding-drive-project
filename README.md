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

Importante:

- Nunca commite `.env`.
- Em plataformas como Vercel, cadastre as variaveis no painel do projeto.
- A `GOOGLE_PRIVATE_KEY_b64` deve conter a chave privada inteira convertida para base64.
- No modo `oauth`, nao use credenciais de Service Account.

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
