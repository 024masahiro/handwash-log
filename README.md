# 手洗いログ

職員が本人の手洗い回数を記録し、管理者が利用者別の回数を確認するアプリです。

**このブランチは Firebase 移行版です。Firebase の設定・既存データの移行・動作確認後に公開を切り替えます。** 公開中の版は、切り替えまで従来の保存先を使用します。

移行後は画面を GitHub Pages、認証を Firebase Authentication、記録を Cloud Firestore、権限の確認と削除処理を Cloud Functions で運用します。ChatGPT のアカウントやサイトへの接続は必要ありません。

- 利用者は氏名・メールアドレス・パスワードの別々の欄で自分のアカウントを登録します。
- 本人の記録だけを追加・取消できます。管理者は日付別の利用者ダッシュボードを確認できます。
- 一般登録では管理者権限を取得できません。所有者の権限は Google の管理権限を持つ専用スクリプトで設定します。
- パスワード再設定リンクを Firebase から自動でメール送信します。
- 本人はパスワードを再確認して退会できます。管理者は一般利用者を削除できます。名簿とその人の記録も削除します。
- ブラウザから Firestore の直接読み書きは許可せず、サーバーが本人と管理者の権限を確認します。

初回設定と切り替えは [Firebase移行手順](docs/firebase-setup.md) を参照してください。

```sh
npm ci
npm ci --prefix firebase-functions
npm run test:firebase
```

テストには Java 21 以上が必要です。認証・データ保存のエミュレーターだけを使用し、実利用者や本番メールは使用しません。

```sh
# firebase-web.example.json を firebase-web.json にコピーして公開用設定を入力
npm run build:firebase
```

GitHub Pages の設定は GitHub Actions にします。`FIREBASE_WEB_CONFIG` という Actions のリポジトリ変数に、ウェブアプリの公開設定を JSON で登録します。公開設定の不足やエミュレーター用設定を検出した場合は公開ビルドを停止します。

利用者情報・記録・旧パスワードハッシュ・Google の秘密鍵は公開リポジトリへ入れません。従来のソースと移行ファイルは切り替え前の確認用に保持していますが、Firebase版の公開ビルドには含みません。
