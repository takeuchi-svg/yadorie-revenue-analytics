import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase/server'
import type { UploadResult } from '@/lib/etl/types'

const VALID_TABLES = [
  'raw_reservation',
  'raw_basic_product',
  'raw_other_product',
  'raw_payment',
  'raw_booking_event',
  'raw_rate_snapshot',
] as const

type ValidTable = (typeof VALID_TABLES)[number]

const UPSERT_KEYS: Record<ValidTable, string> = {
  raw_reservation: 'facility,pms_id',
  raw_basic_product: '',
  raw_other_product: '',
  raw_payment: '',
  raw_booking_event: 'facility,notify_no',
  raw_rate_snapshot: '',
}

const BATCH_SIZE = 500

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { payloads } = body as { payloads: { table: string; data: Record<string, unknown>[] }[] }

    if (!Array.isArray(payloads) || payloads.length === 0) {
      return NextResponse.json({ error: 'No payloads provided' }, { status: 400 })
    }

    const results: UploadResult[] = []

    for (const payload of payloads) {
      const { table, data } = payload

      if (!VALID_TABLES.includes(table as ValidTable)) {
        results.push({ table, inserted: 0, error: `Invalid table: ${table}` })
        continue
      }

      if (!data || data.length === 0) {
        results.push({ table, inserted: 0, error: 'No data' })
        continue
      }

      try {
        let totalInserted = 0
        const onConflict = UPSERT_KEYS[table as ValidTable]

        for (let i = 0; i < data.length; i += BATCH_SIZE) {
          const batch = data.slice(i, i + BATCH_SIZE)

          if (onConflict) {
            const { error, count } = await supabaseAdmin
              .from(table)
              .upsert(batch, { onConflict, ignoreDuplicates: false, count: 'exact' })

            if (error) throw error
            totalInserted += count ?? batch.length
          } else {
            const { error, count } = await supabaseAdmin
              .from(table)
              .insert(batch, { count: 'exact' })

            if (error) throw error
            totalInserted += count ?? batch.length
          }
        }

        results.push({ table, inserted: totalInserted })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        results.push({ table, inserted: 0, error: message })
      }
    }

    return NextResponse.json({ results })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
