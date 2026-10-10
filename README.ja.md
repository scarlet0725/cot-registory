# cot

[English](./README.md) | 日本語

**cot** は [Cloudflare Workers](https://developers.cloudflare.com/workers/) 上で完結して動作する OCI 準拠のコンテナレジストリです。コンテンツは [R2](https://developers.cloudflare.com/r2/) に、メタデータは [D1](https://developers.cloudflare.com/d1/) に保存され、[zot](https://zotregistry.dev/) の精神を受け継いだ軽量・JS 不要のダッシュボードを備えています。

サーバー不要、コンテナをホストするためのコンテナも不要。`docker push` でプッシュし、どこからでもプルし、ダッシュボードで閲覧できます。

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/scarlet0725/cot-registory)

## 特徴

- **OCI Distribution Spec v1.1**: プル、プッシュ(チャンク + モノリシック + クロスリポジトリマウント)、コンテンツディスカバリ(`tags/list`、`_catalog`)、コンテンツ管理(削除)、さらにアーティファクト(SBOM、署名、アテステーション)向けの **Referrers API**(`artifactType` フィルタリング対応)。
- **R2 上のコンテンツアドレスストレージ**: blob はリポジトリ間で重複排除され、クロスリポジトリマウントは純粋なメタデータ操作です。
- **R2 自体によるダイジェスト検証**: アップロードは R2 ネイティブの SHA-256 チェックサム強制を伴ってストリーミングされ、破損したプッシュが可視化されることはありません。
- **軽量ダッシュボード**: サイズ付きリポジトリ一覧、タグブラウザ、マニフェスト/レイヤーインスペクタ、リファラアーティファクト、マルチアーキテクチャインデックスのナビゲーション。サーバーレンダリング、外部アセットゼロ、`prefers-color-scheme` によるダーク/ライト対応。
- **トークンベース認証**: `/admin` ダッシュボードでアクセストークンを発行・失効できます(SHA-256 ハッシュとして保存、定数時間比較)。クライアントは通常の `docker login` を使用します。
- **リポジトリごとの公開設定**: 各リポジトリは **private**(プルにもトークンが必要)または **public**(匿名プル、カタログおよびダッシュボードでの表示が可能)で、`/admin` から切り替えられます。
- **ガベージコレクション**(cron トリガー): 放棄されたアップロードセッション、参照されていない blob とマニフェストを回収します。
- **極小フットプリント** — ランタイム依存は [Hono](https://hono.dev/) のみで、それ以外はすべてプラットフォーム API です。gzip 圧縮で約 16 KB。

## アーキテクチャ

```
docker / podman / oras / crane            ブラウザ
        │  /v2/* (OCI API)                  │  / (ダッシュボード)
        ▼                                   ▼
┌─────────────────── Cloudflare Worker (cot) ───────────────────┐
│  Hono ルーター → 認証 (Basic) → ハンドラ     SSR ダッシュボード │
└──────┬──────────────────────────────┬─────────────────────────┘
       ▼                              ▼
   R2 バケット                      D1 データベース
   blobs/<digest>      コンテンツ   repositories (visibility), tags,
   manifests/<digest>  (バイト列)   manifests, repo_blobs, uploads,
   staging/<uuid>                   credentials (トークンハッシュ)
       ▲
       └── cron トリガー: GC (滞留アップロード、孤立コンテンツ)
```

アップロードは R2 の**マルチパートアップロード**(`staging/<uuid>`、1 PATCH チャンク = 1 パート)にステージングされ、その後 R2 の `sha256` オプションでコピー中にダイジェストを検証しながらコンテンツアドレスへコピーされます。モノリシックアップロードは同じ検証を伴って `blobs/<digest>` へ直接ストリーミングされ、ステージングはありません。

## クイックスタート

最速の方法は上の **Deploy to Cloudflare** ボタンです。リポジトリをあなたのアカウントにクローンし、R2 バケットと D1 データベースをプロビジョニングし、管理者シークレットの入力を促し、デプロイ時にマイグレーションを適用します。

手動でデプロイする場合の前提条件: Workers、R2、D1 が有効な Cloudflare アカウントと、ローカルの `npm`/`node`。

```sh
git clone https://github.com/scarlet0725/cot-registory && cd cot-registory
npm install

# 1. ストレージの作成
npx wrangler r2 bucket create cot-registry
npx wrangler d1 create cot-registry
#    → 出力された database_id を wrangler.jsonc に貼り付ける

# 2. スキーマの適用
npm run db:migrate

# 3. 管理者認証情報(両方スキップすると OPEN レジストリ — 開発用のみ!)
npx wrangler secret put ADMIN_USERNAME
npx wrangler secret put ADMIN_PASSWORD

# 4. デプロイ
npm run deploy
```

`https://cot.<your-subdomain>.workers.dev/admin` を開き、管理者認証情報でサインインして、**アクセストークンを発行**します — トークン ID がユーザー名、シークレット(一度だけ表示)がパスワードです。あとは通常のレジストリと同じように使えます:

```sh
docker login cot.<your-subdomain>.workers.dev   # トークン ID / シークレット
docker tag alpine cot.<your-subdomain>.workers.dev/infra/alpine:3.20
docker push cot.<your-subdomain>.workers.dev/infra/alpine:3.20
```

ダッシュボードは `https://cot.<your-subdomain>.workers.dev/` で開けます。

## 認証と公開設定

- **管理者認証情報**(`ADMIN_USERNAME`/`ADMIN_PASSWORD` シークレット)は `/admin` ダッシュボードを保護します。ここでアクセストークンの発行・失効とリポジトリの公開設定の切り替えを行います。管理者はレジストリへのフルアクセスも持ちます。
- **アクセストークン**はクライアント(`docker login`、CI)が認証に使うものです。シークレットは SHA-256 ハッシュとしてのみ保存され、失効は即時反映されます。
- **リポジトリはデフォルトで private** です: プル、`tags/list`、カタログエントリ、ダッシュボードページのすべてにトークンが必要です。リポジトリを **public** にすると匿名プルとダッシュボード閲覧が可能になります。プッシュには常にトークンが必要です。
- 存在しないリポジトリへの匿名リクエストには `401`(`404` ではなく)を返すため、private リポジトリの名前が漏れることはありません。
- **管理者シークレットが両方とも未設定**の場合、レジストリは OPEN モードで動作します — `/admin` を含むすべてが認証なしになります。ローカル開発専用です。

> **注意**: Docker は localhost 以外のレジストリに HTTPS を要求します — Workers ドメインは最初から HTTPS に対応しています。カスタムドメインも使用できます(`wrangler.jsonc` に[ルート](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)を追加してください)。

## ローカル開発

```sh
npm run db:migrate:local
npm run dev            # http://localhost:8787
npm test               # vitest + workerd (Miniflare R2/D1)
npm run lint           # biome (フォーマット + リント); `lint:fix` で自動修正
npm run check          # 型チェック + リント + テスト (CI と同じ)
```

ローカルインスタンスへは `docker push localhost:8787/...` でプッシュできます(Docker はデフォルトで `localhost` を insecure レジストリとして扱います)。

## 設定

| 名前 | 種別 | デフォルト | 説明 |
| --- | --- | --- | --- |
| `ADMIN_USERNAME` | secret | *(未設定)* | `/admin`(トークン発行、公開設定)の管理者ユーザー。**両方の**シークレットが未設定 ⇒ オープンレジストリ(開発用のみ)。片方だけ設定した場合はフェイルクローズします。 |
| `ADMIN_PASSWORD` | secret | *(未設定)* | 管理者パスワード。 |
| `REGISTRY_NAME` | var | `"cot"` | ダッシュボードに表示される名前。 |

レジストリクライアントが管理者シークレットを使うことはありません — クライアントは `/admin` で発行されたアクセストークンで認証します。リポジトリごとの公開設定(public/private)は D1 に保存され、同じく `/admin` で管理します。

## 本番運用

レジストリをインターネットに公開する際のチェックリスト:

- **管理者シークレットを設定する。** `ADMIN_USERNAME`/`ADMIN_PASSWORD` が未設定だとレジストリは完全に開放された状態になります。長いランダムなパスワードを使ってください — すべてのリクエストで Basic 認証として受け付けられます。
- **認証情報の総当たりをレート制限する。** Worker はログイン失敗をすべてログに記録します(Workers Logs の `auth: ...` 行)が、自身ではスロットリングしません — IP は意図的に Worker 内で追跡していません。Worker の前段に [WAF レート制限ルール](https://developers.cloudflare.com/waf/rate-limiting-rules/)(例: ステータス 401 のレスポンスに対して)を追加してください。これには `workers.dev` ではなくカスタムドメイン/ゾーンでの運用が必要です。
- **メタデータをバックアップする。** blob/マニフェストの*コンテンツ*は R2 にありますが、タグ、公開設定、トークンは D1 にあります。D1 は 30 日分の [Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/) 履歴を保持します。`wrangler d1 export cot-registry --remote` でオフラインスナップショットを取得できます。
- **ログを監視する。** `wrangler.jsonc` で `observability.enabled` が有効なので、呼び出し、`auth:` 警告、未処理エラー、毎晩の `gc: uploads=… blobs=… manifests=…` サマリーがすべて Workers Logs に記録されます。
- **プラン上限に注意する。** リクエストボディサイズ(レイヤーアップロード、下記参照)、D1 ストレージ、R2 クラス A オペレーションはすべて Cloudflare プランに依存します。

## 制限事項と注意点

- **レイヤーサイズは Cloudflare プランの Workers リクエストボディ上限**に制約されます(Free は 100 MB、Business/Enterprise は最大 500 MB)。Docker は各レイヤーを単一の PATCH でプッシュするため、レイヤーは 1 リクエストに収まる必要があります。アップロードをチャンクに分割するクライアントは、以下のルールの下でそれ以上のサイズも扱えます。
- **チャンクアップロード**: R2 のマルチパートセマンティクスが適用されます — 最後のチャンクを除くすべてのチャンクは**同じサイズ**かつ **5 MiB 以上**である必要があります(レジストリは `OCI-Chunk-Min-Length: 5242880` を通知します)。
- `Content-Length` のないアップロード(チャンク転送エンコーディング — 例: docker がレイヤーをオンザフライで圧縮する場合)もサポートされます: PATCH ボディは一様な 32 MiB のマルチパートパートにストリーミングされ、サイズ制限はありません。`Content-Length` のないモノリシックな単一 POST / 単一 PUT アップロードは **32 MiB** までバッファリングされます(それを超えると 411)。主要なクライアントはこれらに `Content-Length` を付けて送信します。
- **sha256 ダイジェストのみ対応**(sha512 のプッシュは `UNSUPPORTED` で拒否されます)。
- タグ一覧/カタログのページネーションは仕様どおり辞書順です。
- GC は毎日実行されます(`wrangler.jsonc` の cron)。削除には猶予期間が設けられており安全です。

## API サポート

| 仕様領域 | 状況 |
| --- | --- |
| プル (blob、マニフェスト、HEAD、Range) | ✅ |
| プッシュ (POST/PATCH/PUT、単一 POST、マウント) | ✅ |
| コンテンツディスカバリ (`tags/list`、ページネーション、`_catalog`) | ✅ |
| コンテンツ管理 (タグ/マニフェスト/blob の削除) | ✅ |
| Referrers API (+`artifactType` フィルタ、`OCI-Subject`) | ✅ |
| トークン認証 (`WWW-Authenticate: Bearer`) | ❌ Basic 認証のみ |

## ライセンス

[MIT](./LICENSE)
