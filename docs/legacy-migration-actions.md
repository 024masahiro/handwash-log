# 既存データの移行

Firebaseの認証とCloudflareの保存先を準備した後、`Migrate and verify free backend` を所有者がmainから実行します。公開画面の切り替えは、すべての段階が成功してから行います。

1. `preflight`: 本番Firebaseへ検証用PBKDF2パスワードを取り込み、ログインして検証用アカウントを削除します。記録・名簿・メールアドレスはArtifactsへ保存しません。
   移行用Secretを登録したら、`check-backup` で受け取りと復号・指紋照合を確認します。旧サイトへの書き込み停止はこの確認に成功してから行います。
2. 旧サイトの書き込みを停止し、`staff` と `washes` の全行バックアップを照合します。
3. バックアップをAES-GCMで暗号化し、暗号鍵をFirebase管理用鍵から得たRSA公開鍵で保護します。暗号化JSONは非公開のGitHub Secret `HANDWASH_LEGACY_BACKUP` に登録します。公開リポジトリにはデータを含まない照合用の `data/legacy-backup.integrity.json` だけを保存します。
4. `migrate`: ロック中・初回空の保存先に認証と記録を取り込み、全件照合します。同じバックアップから安全に再開できます。
5. `activate`: 移行結果を再照合してCloudflare APIを有効にします。
6. `verify`: 本番環境で本人の記録、重複防止、利用者別集計、職員の管理画面制限、本人と管理者による削除、管理者権限の変更を確認します。検証用アカウント・記録は削除し、元データを再照合します。
7. GitHub Pagesを新しいAPIへ切り替え、画面で確認します。旧サイトの削除と移行専用Secretの削除は切り替え確認後に行います。

実行には既存の `CLOUDFLARE_ACCOUNT_ID`、`CLOUDFLARE_API_TOKEN`、`FIREBASE_SERVICE_ACCOUNT` を使います。秘密鍵・APIトークン・平文バックアップは公開ファイルやActionsのArtifactsに含めません。利用者は切り替え後に通常のログイン画面からログインします。
