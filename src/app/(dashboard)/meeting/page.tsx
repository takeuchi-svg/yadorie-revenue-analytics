'use client'

// 月次会議（ビュー配下）。会議パック・会議記録・構造化抽出。
import MeetingTab from '@/components/meeting-tab'

export default function MeetingPage() {
  return (
    <div className="p-6">
      <MeetingTab />
    </div>
  )
}
