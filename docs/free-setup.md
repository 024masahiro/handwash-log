# 無料プランの設定と切り替え

公開URLは **https://024masahiro.github.io/handwash-log/** のままです。管理者がGoogleとCloudflareの無料アカウントを準備します。職員はアプリのメールアドレスとパスワードで利用でき、ChatGPT・Google・Cloudflareのアカウントは不要です。

## 1. 無料アカウントを作る

1. [Cloudflare](https://dash.cloudflare.com/sign-up)でアカウントを作成し、確認メールのリンクを開きます。Workersの**Free**を使用します。独自ドメインの購入は不要です。
2. ご本人のGoogleアカウントで[Firebase Console](https://console.firebase.google.com/)を開き、空のプロジェクトを作成します。表示名は「手洗いログ」などで構いません。Google Analyticsは不要です。
3. Firebaseは**Spark（無料）**のままにします。支払い情報の登録、Blazeへの変更、Cloud FunctionsやFirestoreの作成は不要です。
4. Firebaseの「プロジェクトの設定 → 全般」にある**プロジェクトID**を確認します。

この段階では公開中のアプリに変更はありません。

## 2. ログインとメール送信を設定する

Firebase Consoleで次を設定します。

1. Authentication → Sign-in methodで**メール／パスワード**を有効にします。
2. Authentication → Settings → Authorized domainsに **024masahiro.github.io** を追加します。
3. プロジェクトの設定 → 全般 → アプリを追加 → **ウェブ `</>`** を選びます。Firebase Hostingは不要です。
4. 表示される `apiKey`、`authDomain`、`projectId`、`appId` を `firebase-web.example.json` の形式で用意します。これはブラウザに公開する設定です。
5. Authentication → Templates → Password resetで日本語のメールを確認します。初期設定ではFirebaseの画面で再設定し、アプリに戻れます。アプリ内の再設定画面を使う場合は、アクションURLを **https://024masahiro.github.io/handwash-log/reset/** に設定します。この画面はFirebaseの `oobCode` を処理します。

再設定メールはFirebaseから自動送信します。Resendなど別のメールサービスは不要です。確認メールは初期のFirebaseアクション画面を使えます。

## 3. Cloudflareの保存先を用意する

Node.js 22以上を使うPC、または権限を安全に接続した実行環境で、このブランチのソースから実行します。

```sh
npm ci
npx --no-install wrangler login
npx --no-install wrangler d1 create handwash-log
```

CloudflareのWorkers & Pagesで無料の `workers.dev` サブドメインを設定します。D1作成で表示された `database_id` を控えます。

`worker/wrangler.jsonc` を **worker/wrangler.json** にコピーし、以下を置き換えます。コピー後も通常のJSON形式で保存します。

- `vars.FIREBASE_PROJECT_ID`：FirebaseのプロジェクトID
- `d1_databases[0].database_id`：D1のID

**`HANDWASH_MIGRATION_LOCK` は `"1"` のまま**にします。移行中は新しいAPIを停止します。

```sh
npx --no-install wrangler d1 migrations apply DB --remote --config worker/wrangler.json
npm run deploy:free
```

表示された **https://handwash-api.設定したサブドメイン.workers.dev** がAPIのURLです。この段階ではロック中なので公開版の保存先として使いません。

## 4. Firebaseの管理用認証情報を設定する

Firebaseのアカウント確認・削除をWorkerから実行するため、専用のサービスアカウントを使用します。

Google Cloud Consoleの「IAMと管理 → サービスアカウント」で対象Firebaseプロジェクト用のアカウントを作り、**Firebase Authentication Admin (`roles/firebaseauth.admin`)** を付与します。JSON形式の鍵を作成し、公開リポジトリの外に保存します。Firebaseの設定 → サービスアカウントから生成した場合も、対象プロジェクトと必要な権限を確認します。

JSON全体をWorkerの **Secret** `FIREBASE_SERVICE_ACCOUNT` に設定します。

```sh
npx --no-install wrangler secret put FIREBASE_SERVICE_ACCOUNT --config worker/wrangler.json
```

コマンドの入力欄へJSONを入力します。Worker → Settings → Variables and Secretsで、種類を**Secret**として登録する方法も使えます。

秘密鍵やCloudflareのAPIトークンをチャット、GitHub、Pagesの変数、通常のWorker変数に貼り付けません。ローカル移行スクリプトは鍵のファイルパスを標準の `GOOGLE_APPLICATION_CREDENTIALS` に設定して実行します。通常のGoogleユーザーの `gcloud auth application-default login` だけではFirebase Authenticationの管理操作に使えません。

Cloudflareの権限は `wrangler login` を使います。自動化用の権限を安全に接続する場合は、対象のWorker・D1操作に限定した `CLOUDFLARE_API_TOKEN` と `CLOUDFLARE_ACCOUNT_ID` を使用します。

## 5. 既存データを移行する

新サービスの準備後に短時間の切り替え作業を行います。旧版の更新だけを停止し、最後の記録まで含むバックアップを取得します。

旧サーバー用 `src/worker.mjs` には `HANDWASH_MIGRATION_FREEZE=1` で記録追加・登録・変更・削除を止める処理があります。旧サーバーへ反映して設定を有効にします。閲覧とログインは継続できます。切り替えを中止する場合は解除して旧版を再開します。

旧データベースの **staffとwashesの全行** を、列名を変えずに非公開の `private-migration/legacy.json` へ保存します。ページ分割された取得では最後のページまで取得し、長いパスワードハッシュが省略されていないことを確認します。

```json
{"staff": [], "washes": []}
```

前述のサービスアカウントで管理操作できる環境で、`YOUR_PROJECT_ID` を置き換えて実行します。

```sh
node scripts/prepare-legacy-free.mjs --backup private-migration/legacy.json --project YOUR_PROJECT_ID --out private-migration/prepared
node scripts/import-auth-free.mjs --backup private-migration/legacy.json --project YOUR_PROJECT_ID --out private-migration/prepared
node scripts/import-d1-free.mjs --backup private-migration/legacy.json --project YOUR_PROJECT_ID --out private-migration/prepared --config worker/wrangler.json
```

後ろの2コマンドは確認のみです。確認後、同じコマンドに **--apply** を追加し、認証、D1の順に取り込みます。

- 初回の取り込み先はAuthenticationとD1の名簿・記録が空である必要があります。
- 中断した場合は同じバックアップ・プロジェクト・準備フォルダーで再実行します。異なるデータの混在を拒否します。
- 利用者ID、名前、メール、管理者区分、記録ID・日時を維持します。認証情報を照合し、D1の名簿・記録は全行を元データと照合します。
- 旧PBKDF2-SHA256ハッシュをFirebaseへインポートします。saltは元のASCIIの16進文字列、反復回数は100,000回です。
- ハッシュがないアカウントは再設定メールでパスワードを設定します。
- メール未設定の旧名簿と記録も残します。管理者がメール・初期パスワードを設定して再開できます。
- 職員との紐付けがない記録は「所属未設定の旧記録」として残します。
- 旧セッション・再設定トークン・メールサービスの鍵は移行しません。移行後はログインし直します。

本番Firebaseで、移行したテスト用アカウントの**既存パスワードによるログイン**も確認します。認証エミュレーターは独自の仮ハッシュを使い、取り込んだPBKDF2でのログインには対応しません。ローカルでは取り込みのバイト列・形式と、移行アカウントの再設定・履歴を確認します。本番の旧パスワード認証は切り替え前の必須確認です。

移行データの全行照合とFirebaseのログイン確認が済んだら、`HANDWASH_MIGRATION_LOCK` を `"0"` にし、**npm run deploy:free** を実行します。公開設定を使った新フロントエンドでAPIを確認し、公開版は次の手順で切り替えます。この確認中も旧版の書き込み停止は維持します。

## 6. 管理者を設定する

旧バックアップの管理者権限を引き継ぎます。一般登録から管理者になれる画面やAPIはありません。

所有者は **024masahiro@gmail.com** に固定します。アカウントがない場合はデータ移行後に通常の登録を行い、アカウント設定の「確認メールを送信」でメールを確認します。

```sh
node scripts/set-owner-free.mjs --project YOUR_PROJECT_ID
```

前述のサービスアカウントによる管理権限が必要です。メール未確認・アカウント停止中の場合は付与を拒否します。操作後にログインし直します。既存の認証済み所有者は移行情報を引き継ぎます。

## 7. GitHub Pagesを切り替える

Settings → Secrets and variables → Actions → **Variables** に登録します。

| 変数 | 内容 |
| --- | --- |
| FIREBASE_WEB_CONFIG | 省略可。登録済みの `firebase-web.public.json` を使用します。別の設定で上書きする場合は `apiKey`、`authDomain`、`projectId`、`appId` のJSONを指定します |
| HANDWASH_API_ORIGIN | `https://handwash-api.設定したサブドメイン.workers.dev` |

これは公開設定で、秘密鍵は含めません。無料構成の検証、移行、管理者設定、メール受信が確認できてからブランチをmainへ反映します。Sourceは設定済みのGitHub Actionsです。設定不足では公開ビルドを止め、稼働中の版を置き換えません。

公開URLで登録、ログイン、本人の追加と取消、旧履歴、一般利用者の管理画面拒否、利用者別件数、実際の再設定メール受信と再ログイン、退会、管理者による削除を確認します。旧ChatGPTサイト・Cloud Functions・Firestoreへの通信がないことも確認します。

## 8. 旧ChatGPTサイトを削除する

新構成の動作とデータの一致を確認し、非公開バックアップを保持してから旧サイトを削除します。接続しているサイト管理ツールにはサイト本体の削除機能がないため、所有者のサイト管理画面から削除します。切り替え前の削除は公開中のアプリの保存を止めてしまいます。

## 無料枠での運用

2026年10月の公式案内に基づく主な上限です。

| サービス | 無料枠 |
| --- | --- |
| Workers Free | 1日100,000リクエスト、1実行のCPU時間10ms |
| D1 Free | 1日500万行の読み込み、10万行の書き込み、アカウント全体5GB |
| Firebase Spark | パスワード再設定メール1日150通 |

20人が1日20回記録する例なら400記録です。索引への書き込みや画面の読み込みも使用量に含みますが、通常利用は無料枠内を想定しています。本人の7日分の履歴は毎分読み直さず、追加・取消・画面への復帰・「最新の記録を確認」で更新します。管理者の当日集計は毎分更新します。

Free/Sparkのままでは上限到達時に処理が制限されます。有料プランへ自動変更する処理はありません。無制限の利用や将来の料金体系は保証できないため、使用量をダッシュボードで確認し、有料プランへ変更せず運用します。実際のWorkerの応答・CPU使用量も切り替え前に確認します。

- [Workers料金](https://developers.cloudflare.com/workers/platform/pricing/)
- [Workers制限](https://developers.cloudflare.com/workers/platform/limits/)
- [D1料金](https://developers.cloudflare.com/d1/platform/pricing/)
- [Firebase認証の制限](https://firebase.google.com/docs/auth/limits)
