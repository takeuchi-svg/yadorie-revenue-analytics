# yadorie-revenue-analytics

YADORIE GROUP 売上分析BIダッシュボード

旅館・ホテルの売上を多次元分析するBIシステム。PMS(Staysee)・サイトコントローラ(Lincoln)・
レート表のCSV/Excelを取り込み、Supabaseに蓄積し、ダッシュボードで可視化する。

## ドキュメント

| 文書 | 内容 |
|------|------|
| [docs/要件定義書.md](docs/要件定義書.md) | 目的・機能要件・進捗 |
| [docs/UI仕様書.md](docs/UI仕様書.md) | 画面・配色・チャートの正（UI実装の唯一の基準）|
| [docs/データベース設計書.md](docs/データベース設計書.md) | テーブル・ビュー・ETL・重複防止 |
| [CLAUDE.md](CLAUDE.md) | 開発方針（参照すべき文書・環境メモ）|

## 技術スタック

- Next.js 16 (App Router) + TypeScript + Tailwind CSS
- Supabase (PostgreSQL) + Supabase Auth
- Recharts / PapaParse / SheetJS
- Vercel（mainブランチ自動デプロイ）

## 開発

```bash
npm install
npm run dev      # http://localhost:3000
npm run build    # 本番ビルド
```

`.env.local` に Supabase の URL / anon key / service_role key が必要（gitignore済み）。

## 本番

- URL: https://yadorie-revenue-analytics-beta.vercel.app
- mainブランチへのpushで自動デプロイ
- DBマイグレーション: `node scripts/migrate.mjs`

## データ取込

`/upload` 画面に各CSV/Excelをドラッグ&ドロップ。詳細は[データベース設計書](docs/データベース設計書.md)参照。
