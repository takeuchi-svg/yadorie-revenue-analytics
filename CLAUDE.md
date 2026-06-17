@AGENTS.md

# プロジェクト方針

このプロジェクトのUI実装は `/docs/UI仕様書.md` に従うこと。
データベース設計は `/docs/データベース設計書.md` に従うこと。
要件は `/docs/要件定義書.md` を参照すること。

本番環境はSupabaseを使用。**localStorageは使わない**（データ・UI状態とも。施設選択はCookieで保持する）。

## 環境メモ
- 本番URL: https://yadorie-revenue-analytics-beta.vercel.app
- ホスティング: Vercel（個人アカウント takeuchi-svg / mainブランチへのpushで自動デプロイ）
- 作業ブランチ: main
- Gitコミットメール: takeuchi@okamijuku.com（GitHubアカウントと一致させること）
- ログインユーザー: takeuchi@okamijuku.com
- 先行施設: FRY（山の手ホテル）
