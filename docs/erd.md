# ER図（シフト・労務管理 v1）

> ⚠️ 更新（as-built）: 実装で一部変更あり。DB全体の正は [`データベース全体設計.md`](データベース全体設計.md)。
> - **人件費モデルv2で個人給与は撤去済み**（2026-07）。`dim_staff_wage` / `mart_labor_cost_actual` / `mart_labor_cost_plan` は**存在しない**。下図でそれらを賃金結線している箇所は無効。
>   現行は `dim_labor_rate`（宿の標準時給）＋ `raw_regular_labor_monthly`（正社員 宿×月lump）で、`dim_staff` は個人給与を持たない（is_spot / employment_type 等のみ）。
> - `budget_daily` の日付列は **`date`**（下図の work_date は誤り。ビュー側で date→work_date 別名）。

凡例: 既存＝再利用（`dim_staff`/`raw_attendance_daily`/`dim_facility_mapping`/`budget_daily`）、新規＝シフト系テーブル、`mart_*`＝集計ビュー。
施設キーは `work_facility`/`facility`（BIコード）、従業員キーは `staff_code`（KOTコード）。時間は分(整数)。

```mermaid
erDiagram
  dim_staff ||--o{ raw_attendance_daily : "staff_code"
  dim_staff ||--o{ raw_shift_plan : "staff_code"
  dim_staff ||--o{ mart_labor_cost_actual : "賃金"
  dim_facility_mapping ||--o{ raw_attendance_daily : "施設"
  dim_facility_mapping ||--o{ raw_shift_plan : "施設"
  dim_facility_mapping ||--o{ budget_daily : "施設"
  dim_facility_mapping ||--o{ raw_daily_plan_context : "施設"
  dim_role ||--o{ raw_shift_segment : "role_id"
  dim_role ||--o{ dim_shift_pattern : "既定役割"
  dim_shift_pattern ||--o{ raw_shift_plan : "pattern_id"
  raw_shift_plan ||--o{ raw_shift_segment : "shift_id"
  raw_shift_plan ||--o{ mart_shift_variance : "予"
  raw_attendance_daily ||--o{ mart_shift_variance : "実"
  raw_attendance_daily ||--o{ mart_labor_cost_actual : "実"
  budget_daily ||--o{ mart_daily_plan_context : "予算"
  raw_daily_plan_context ||--o{ mart_daily_plan_context : "手入力"

  dim_facility_mapping {
    text attendance_code PK
    text facility
    text attendance_name
  }
  dim_staff {
    text staff_code PK
    text name
    text wage_type
    numeric hourly_wage
    numeric monthly_salary
    numeric deemed_ot_hours
    numeric contracted_monthly_hours
    bool is_spot
  }
  budget_daily {
    text facility
    date date
    int rooms_sold
    int guests
  }
  raw_attendance_daily {
    bigint id PK
    text staff_code FK
    date work_date
    text work_facility
    int total_work_min
    text source
  }
  dim_role {
    bigint role_id PK
    text role_name
    text color
  }
  dim_shift_pattern {
    bigint pattern_id PK
    text pattern_type
    text name
    time start_time
    time end_time
    int break_minutes
    bool is_paid
    text color
  }
  raw_shift_plan {
    bigint shift_id PK
    text staff_code FK
    text work_facility
    date work_date
    bigint pattern_id FK
    int planned_minutes
  }
  raw_shift_segment {
    bigint segment_id PK
    bigint shift_id FK
    bigint role_id FK
    time start_time
    time end_time
    int work_minutes
  }
  raw_daily_plan_context {
    text facility
    date work_date
    int onhand_rooms
    int forecast_rooms
    text memo
  }
  mart_shift_variance {
    text staff_code
    text work_facility
    date work_date
    int plan_minutes
    int actual_minutes
    int variance_minutes
  }
  mart_labor_cost_actual {
    text staff_code
    date ym
    numeric hours
    numeric labor_cost
    numeric ot_pay_over_deemed
    numeric spot_hours
  }
  mart_daily_plan_context {
    text facility
    date work_date
    int budget_rooms
    int budget_guests
    int onhand_rooms
    int forecast_rooms
    text memo
  }
```
