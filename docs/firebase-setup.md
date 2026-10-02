# Firebase の準備と切り替え

画面の公開先は https://024masahiro.github.io/handwash-log/ のままです。Firebase は Google のログイン・データ保存サービスです。運用後に利用者が ChatGPT または Google のアカウントを持つ必要はありません。メールアドレスとパスワードで利用します。

## 1. プロジェクトを確認する

[Firebase Console](https://console.firebase.google.com/) をご本人の Google アカウントで開きます。

- 既存プロジェクトがあれば、歯車 → プロジェクトの設定 → 全般にある **プロジェクトID** を確認します。
- なければ「プロジェクトを作成」を選びます。表示名は「手洗いログ」などで構いません。Google Analytics はこのアプリには不要です。
- 作成だけの段階では、公開中のアプリには変更を加えません。

Cloud Functions を本番公開するためには **Blaze（従量課金）プランと支払い方法の登録** が必要です。Firestore と Functions の無料利用枠を超えると料金が発生します。使用量に応じた請求であり、予算アラートは支出の上限を保証しません。課金プランの選択と支払い設定はご本人が行ってください。

## 2. サービスを設定する

1. Authentication → Sign-in method で **メール／パスワード** を有効にします。メールリンクのみの認証ではありません。
2. Authentication → Settings → Authorized domains に **024masahiro.github.io** を追加します。
3. Firestore Database を **Native mode、デフォルトデータベース `(default)`** で作成します。リージョンは **asia-northeast1（東京）** を推奨します。作成後に変更できないため、既存データベースがある場合は所在を確認します。
4. プロジェクトの設定 → 全般 → アプリを追加 → **ウェブ `</>`** を選びます。Firebase Hosting の設定は不要です。
5. 表示される公開設定から `apiKey`、`authDomain`、`projectId`、`appId` を `firebase-web.example.json` の形式で用意します。これらはブラウザへ公開する設定です。サービスアカウントの秘密鍵と区別してください。
6. Authentication → Templates → Password reset で日本語のメールを確認します。初期設定では Firebase の再設定画面で新パスワードを入力後、このアプリのログイン画面に戻ります。独自画面を使用する場合は、メールのアクションURLを `https://024masahiro.github.io/handwash-log/reset/` に設定します。アプリは Firebase の `oobCode` と `mode=resetPassword` を処理します。

Resend など別のメール送信サービスの契約・APIキーは必要ありません。

## 3. Firebase のサーバーを公開する

ご本人の PC または Google の権限を設定した実行環境で、Node.js 22 を使います。

```sh
npm ci
npm ci --prefix firebase-functions
npx firebase login
npx firebase deploy --project YOUR_PROJECT_ID --only firestore,functions
```

`YOUR_PROJECT_ID` は実際のプロジェクトIDに置き換えます。権限のある Google アカウントで操作してください。認証情報やサービスアカウントの秘密鍵をチャット・GitHubに貼り付けないでください。

バックアップの読み込みと所有者権限の設定は Admin SDK を使うため、Firebase CLI のログインとは別に Application Default Credentials が必要です。権限のある Google アカウントで Google Cloud CLI を使います。

```sh
gcloud auth application-default login
gcloud auth application-default set-quota-project YOUR_PROJECT_ID
```

代わりに権限を限定したサービスアカウントを使う場合は、秘密鍵を公開リポジトリ外に置き、Google の標準 `GOOGLE_APPLICATION_CREDENTIALS` 設定を使います。

## 4. 既存の名簿と記録を移行する

移行中の保存先への書き込みは行いません。新しい保存先を公開前に検証し、切り替え時には旧版への記録追加・登録・変更・削除を一時停止してからバックアップを取得します。最後の記録までを含む同一時点のバックアップが必要です。

このブランチの旧サーバーソースには `HANDWASH_MIGRATION_FREEZE=1` で API の更新処理だけを停止する機能を用意しています。新しい Firebase サーバーの準備が完了してから、旧サーバーにこの変更を反映し、この設定を有効にします。閲覧とログインは継続できます。切り替えに失敗して旧版を再開する場合は、設定を解除します。停止中にも記録が増えていないことを確認してから全行を取得します。

旧データベースから `staff` と `washes` の**全行**を、非公開ファイル `private-migration/legacy.json` に保存します。

```json
{"staff": [], "washes": []}
```

行の列名は変更しません。ハッシュなどの長い文字列が省略・切り詰めされていないことを確認します。セッション、旧メール送信サービスの鍵、再設定トークンは移行しません。

```sh
# 件数と形式を確認するだけ
node scripts/import-legacy.mjs --backup private-migration/legacy.json --project YOUR_PROJECT_ID --owner 024masahiro@gmail.com

# 空の移行先に取り込む
node scripts/import-legacy.mjs --backup private-migration/legacy.json --project YOUR_PROJECT_ID --owner 024masahiro@gmail.com --apply
```

初回の移行先は Authentication のユーザーと Firestore の名簿が空である必要があります。中断時は**同じバックアップと所有者メール**で再実行できます。完了後の再実行はデータを上書きしません。取り込み前のバックアップと移行後の名簿・記録の件数を照合します。

- 利用者IDと記録時刻を維持します。
- 旧 PBKDF2-SHA256 のパスワードハッシュを Firebase のインポート機能へ渡します。salt は元の実装と同じ ASCII の16進文字列、反復回数は100,000回です。
- パスワードハッシュがないアカウントは再設定メールからパスワードを設定します。
- メールが未設定の旧名簿は記録ごと維持します。管理者がメールと初期パスワードを設定して利用を再開できます。
- 職員との紐付けがない旧記録は「所属未設定の旧記録」としてダッシュボードに残します。
- 移行後は全員が一度ログインし直します。移行前に届いた再設定リンクは使用しません。

本番切り替え前には、既存のテスト用アカウントのパスワードで Firebase にログインできることも確認します。エミュレーターでのハッシュ形式検証だけでは本番のインポート認証まで保証できません。

## 5. 管理者を設定する

旧管理者は信頼されたバックアップの `is_admin` を引き継ぎます。所有者のアカウントは次の専用操作で設定できます。管理者権限を設定するウェブAPIは公開しません。

```sh
node scripts/set-owner.mjs --project YOUR_PROJECT_ID
```

対象はこのリポジトリの所有者のメールアドレス `024masahiro@gmail.com` に固定しています。移行で該当アカウントがない場合は、データ移行を先に完了してから、このメールアドレスで通常の利用者登録を行います。アカウント設定の「確認メールを送信」から届いた確認リンクを開きます。その後スクリプトを実行し、ログインし直します。未確認のメールアドレスには、このスクリプトで管理者権限を付与できません。

## 6. GitHub Pages を切り替える

リポジトリの Settings → Secrets and variables → Actions → **Variables** に `FIREBASE_WEB_CONFIG` を追加します。値は、以下の形式の JSON です。

```json
{"apiKey":"実際の公開APIキー","authDomain":"YOUR_PROJECT_ID.firebaseapp.com","projectId":"YOUR_PROJECT_ID","appId":"実際のウェブアプリID"}
```

Firebase 移行ブランチの検証が成功し、データ移行と管理者の設定が済んでから `main` に反映します。Pages のワークフローは Firebase 版をビルドします。設定不足では公開を停止するため、未設定の画面で稼働中の版を置き換えません。

切り替え後、公開URLで次を確認します。

- 新規登録・ログイン・ログアウト
- 本人の記録の追加と取消、旧履歴の表示
- 一般利用者が管理者画面に入れないこと
- 管理者ダッシュボードの職員ごとの件数
- 再設定メールの受信・パスワード変更・変更後のログイン
- 退会と管理者による一般利用者の削除
- 開発者ツールで旧 ChatGPT サイトへの通信が発生しないこと

## 7. 旧サイトを削除する

Firebase 版の運用と件数の一致を確認した後、旧サイトのバックアップを保持して旧サイトを削除します。この環境のサイト管理ツールにはサイト本体を削除する操作がないため、サイト所有者の管理画面からご本人が削除します。切り替え前に旧サイトを削除すると、公開中の版が記録できなくなります。
