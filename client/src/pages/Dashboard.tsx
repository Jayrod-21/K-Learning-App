/**
 * Dashboard Page
 * Central hub showing all learning progress metrics.
 * Displays: TOPIK readiness, streak, vocab mastered, reading level,
 * Korean age, weak area heatmap, and quick action navigation.
 */
import { useAuth } from '../hooks/useAuth';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  Cell,
} from 'recharts';

/** Placeholder weak area data for the heatmap chart */
const weakAreaData = [
  { area: '어휘', label: 'Vocab', score: 65 },
  { area: '문법', label: 'Grammar', score: 45 },
  { area: '읽기', label: 'Reading', score: 55 },
  { area: '듣기', label: 'Listening', score: 30 },
  { area: '쓰기', label: 'Writing', score: 20 },
];

/** Color based on score: red < 40, yellow < 60, green >= 60 */
function getScoreColor(score: number): string {
  if (score >= 60) return '#2D5A27';
  if (score >= 40) return '#C9A84C';
  return '#8B1A1A';
}

/** Quick action buttons for navigating to modules */
const quickActions = [
  { label: '단어 복습', sublabel: 'Vocabulary', path: '/vocab', icon: '📚' },
  { label: '문법 수업', sublabel: 'Grammar', path: '/grammar', icon: '✏️' },
  { label: 'TOPIK 연습', sublabel: 'TOPIK Prep', path: '/topik', icon: '📝' },
  { label: 'AI 대화', sublabel: 'Conversation', path: '/conversation', icon: '💬' },
  { label: '읽기 연습', sublabel: 'Reading', path: '/reading', icon: '📖' },
  { label: '발음 연습', sublabel: 'Speaking', path: '/speaking', icon: '🗣️' },
];

export default function Dashboard() {
  const { user, logout } = useAuth();

  /* Placeholder metrics — will be wired to Supabase in Phase 8 */
  const metrics = {
    topik1Readiness: 42,
    topik2Readiness: 18,
    streak: 7,
    dailyGoal: 60,
    dailyProgress: 35,
    vocabMastered: 156,
    vocabTotal: 800,
    readingLevel: '초등' as const,
    koreanAge: 8,
  };

  return (
    <div className="min-h-screen bg-ink text-paper">
      {/* Header */}
      <header className="border-b border-paper/10 px-6 py-4 flex items-center justify-between">
        <div>
          <h1 className="font-korean text-2xl font-bold">한국어 마스터</h1>
          <p className="text-paper/50 text-sm">
            안녕하세요! 오늘도 열심히 공부합시다.
          </p>
        </div>
        <div className="flex items-center gap-4">
          <span className="text-paper/50 text-sm">{user?.email}</span>
          <button
            onClick={logout}
            className="text-paper/40 hover:text-paper text-sm transition-colors"
          >
            Logout
          </button>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-6 py-8 space-y-8">
        {/* TOPIK Readiness Cards */}
        <section className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <ReadinessCard
            label="TOPIK I"
            percentage={metrics.topik1Readiness}
            sublabel="Level 1-2"
          />
          <ReadinessCard
            label="TOPIK II"
            percentage={metrics.topik2Readiness}
            sublabel="Level 3-6"
          />
        </section>

        {/* Stats Row */}
        <section className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <StatCard
            label="연속 학습"
            value={`${metrics.streak}일`}
            sublabel="Daily Streak"
          />
          <StatCard
            label="마스터한 단어"
            value={`${metrics.vocabMastered}`}
            sublabel={`of ${metrics.vocabTotal} TOPIK I`}
          />
          <StatCard
            label="읽기 수준"
            value={metrics.readingLevel}
            sublabel="Reading Level"
          />
          <StatCard
            label="한국어 나이"
            value={`${metrics.koreanAge}세`}
            sublabel="Korean Age"
          />
        </section>

        {/* Daily Goal Progress */}
        <section className="bg-ink border border-paper/10 rounded-lg p-6">
          <div className="flex items-center justify-between mb-3">
            <h3 className="font-semibold">오늘의 목표 | Daily Goal</h3>
            <span className="text-paper/50 text-sm">
              {metrics.dailyProgress}/{metrics.dailyGoal} min
            </span>
          </div>
          <div className="w-full bg-paper/10 rounded-full h-3">
            <div
              className="bg-accent h-3 rounded-full transition-all duration-500"
              style={{
                width: `${Math.min(100, (metrics.dailyProgress / metrics.dailyGoal) * 100)}%`,
              }}
            />
          </div>
        </section>

        {/* Weak Area Heatmap */}
        <section className="bg-ink border border-paper/10 rounded-lg p-6">
          <h3 className="font-semibold mb-4">약점 분석 | Weak Areas</h3>
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={weakAreaData} layout="vertical">
              <XAxis type="number" domain={[0, 100]} hide />
              <YAxis
                type="category"
                dataKey="area"
                width={50}
                tick={{ fill: '#F5F0E8', fontSize: 14 }}
              />
              <Tooltip
                formatter={(value) => [`${value}%`, 'Score']}
                contentStyle={{
                  backgroundColor: '#1A1A2E',
                  border: '1px solid rgba(245,240,232,0.1)',
                  borderRadius: '8px',
                  color: '#F5F0E8',
                }}
              />
              <Bar dataKey="score" radius={[0, 4, 4, 0]}>
                {weakAreaData.map((entry, index) => (
                  <Cell key={index} fill={getScoreColor(entry.score)} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </section>

        {/* Quick Actions */}
        <section>
          <h3 className="font-semibold mb-4">빠른 시작 | Quick Start</h3>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
            {quickActions.map((action) => (
              <button
                key={action.path}
                className="bg-ink border border-paper/10 hover:border-accent/50 rounded-lg p-4 text-left transition-colors group"
              >
                <span className="text-2xl block mb-2">{action.icon}</span>
                <span className="font-korean text-sm font-semibold block">
                  {action.label}
                </span>
                <span className="text-paper/40 text-xs">{action.sublabel}</span>
              </button>
            ))}
          </div>
        </section>
      </main>
    </div>
  );
}

/** TOPIK readiness percentage card */
function ReadinessCard({
  label,
  percentage,
  sublabel,
}: {
  label: string;
  percentage: number;
  sublabel: string;
}) {
  return (
    <div className="bg-ink border border-paper/10 rounded-lg p-6">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="font-semibold text-lg">{label}</h3>
          <p className="text-paper/40 text-sm">{sublabel}</p>
        </div>
        <div className="text-right">
          <span className="text-3xl font-bold text-accent">{percentage}%</span>
          <p className="text-paper/40 text-xs">준비도 | Readiness</p>
        </div>
      </div>
      <div className="mt-4 w-full bg-paper/10 rounded-full h-2">
        <div
          className="bg-primary h-2 rounded-full transition-all duration-500"
          style={{ width: `${percentage}%` }}
        />
      </div>
    </div>
  );
}

/** Small stat display card */
function StatCard({
  label,
  value,
  sublabel,
}: {
  label: string;
  value: string;
  sublabel: string;
}) {
  return (
    <div className="bg-ink border border-paper/10 rounded-lg p-4 text-center">
      <p className="font-korean text-sm text-paper/60 mb-1">{label}</p>
      <p className="text-2xl font-bold text-accent">{value}</p>
      <p className="text-paper/30 text-xs mt-1">{sublabel}</p>
    </div>
  );
}
