# Cloudflareの初期設定をGitHubから実行する

Firebaseのウェブアプリ・メール／パスワード認証とGitHub Pagesの承認済みドメインを設定した後に進めます。FirebaseはSpark、CloudflareはWorkers/D1 Freeを使います。

## GitHubに3つのSecretを登録する

[手洗いログのSecrets画面](https://github.com/024masahiro/handwash-log/settings/secrets/actions)で「New repository secret」を押して登録します。認証情報はこの画面へ入力します。チャットや公開ファイルへ貼り付けません。

| Name | Secretに入力する内容 |
| --- | --- |
| CLOUDFLARE_ACCOUNT_ID | Cloudflareダッシュボードに表示される32文字のAccount ID |
| CLOUDFLARE_API_TOKEN | 対象アカウントのWorkers ScriptsとD1の編集権限を持つAPIトークン |
| FIREBASE_SERVICE_ACCOUNT | Firebaseのサービスアカウント鍵のJSON全体 |

### Cloudflareのトークン

[APIトークン画面](https://dash.cloudflare.com/profile/api-tokens)で「Create Token」→「Create Custom Token」を選び、名前はhandwash-logとします。

- Permissions: Account → Workers Scripts → Edit
- Permissions: Account → D1 → Edit
- Account Resources: 対象の自分のアカウントだけ

作成されたトークンをGitHubの `CLOUDFLARE_API_TOKEN` に登録します。CloudflareダッシュボードのアカウントIDは `CLOUDFLARE_ACCOUNT_ID` に登録します。

### Firebaseの管理用JSON

[Firebaseのサービスアカウント画面](https://console.firebase.google.com/project/handwash-log/settings/serviceaccounts/adminsdk)で、対象がhandwash-logであることを確認し、「新しい秘密鍵の生成」からJSONを取得します。ファイルをテキストエディターで開き、その全体をGitHubの `FIREBASE_SERVICE_ACCOUNT` に登録します。公開用のfirebaseConfigとは別の、非公開の管理用認証情報です。

この専用プロジェクトの管理用アカウントはFirebase Authenticationのユーザー管理権限が必要です。独自にサービスアカウントを作る場合は `roles/firebaseauth.admin` を使います。

## 初期設定を実行する

[GitHub Actions](https://github.com/024masahiro/handwash-log/actions)で **Prepare free backend** → **Run workflow** を選び、ブランチは **main** のまま実行します。接続情報の入力後、こちらに実行を依頼することもできます。現在のGitHub連携権限で実行できない場合は、ご本人がこのボタンを押します。

処理は以下を行います。

1. Secretの形式とFirebaseのプロジェクトIDを確認する
2. 無料のworkers.devサブドメインとD1データベースを用意する
3. データベースの構造を適用して、検証済みのWorkerを公開する
4. Firebaseの管理用JSONをWorkerのSecretへ設定する
5. 移行ロックが有効であることを確認する

有料プランへの変更は行いません。既存の別Workerを上書きせず、運用を開始したWorkerを初期設定で再ロックすることも拒否します。

成功した実行のArtifactsに **backend-public-config** が表示されます。内容はAPI URL、DB ID、移行ロックと公開鍵です。秘密鍵やAPIトークンは含みません。

この処理だけでは公開画面や既存データを切り替えません。旧データを照合して移行した後、GitHub Pagesを新しい保存先へ接続します。
