/**
 * Dashboard Page
 * Central hub showing all learning progress metrics.
 * Displays: TOPIK I & II exam readiness, streak, vocab mastered,
 * reading level, Korean age, weak area heatmap, and quick action navigation.
 */
import { Link } from 'react-router-dom';
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

/** Weak area data — starts at 0, will be wired to Supabase */
const weakAreaData = [
  { area: '어휘', label: 'Vocab', score: 0 },
  { area: '문법', label: 'Grammar', score: 0 },
  { area: '읽기', label: 'Reading', score: 0 },
  { area: '듣기', label: 'Listening', score: 0 },
  { area: '쓰기', label: 'Writing', score: 0 },
];

/** Color based on score: red < 40, yellow < 60, green >= 60 */
function getScoreColor(score: number): string {
  if (score >= 60) return '#2D5A27';
  if (score >= 40) return '#C9A84C';
  return '#8B1A1A';
}

/** Quick action buttons for navigating to modules */
const quickActions = [
  { label: '교육과정', sublabel: 'Curriculum', path: '/curriculum', icon: '📋' },
  { label: '단어 복습', sublabel: 'Vocabulary', path: '/vocab', icon: '📚' },
  { label: '문법 수업', sublabel: 'Grammar', path: '/grammar', icon: '✏️' },
  { label: 'TOPIK 연습', sublabel: 'TOPIK Prep', path: '/topik', icon: '📝' },
  { label: 'AI 대화', sublabel: 'Conversation', path: '/conversation', icon: '💬' },
  { label: '읽기 연습', sublabel: 'Reading', path: '/reading', icon: '📖' },
];

export default function Dashboard() {
  const { user, logout } = useAuth();

  /** All metrics start at 0 — will be driven by Supabase progress data */
  const metrics = {
    topik1Readiness: 0,
    topik2Readiness: 0,
    streak: 0,
    dailyGoal: 60,
    dailyProgress: 0,
    vocabMastered: 0,
    vocabTotal: 1500,
    readingLevel: '—',
    koreanAge: 0,
  };

  return (
    <div className="text-[#F5F0E8]">
      <main className="max-w-6xl mx-auto px-6 py-8 space-y-8">
        {/* Greeting */}
        <div>
          <h1 className="font-['Noto_Sans_KR'] text-2xl font-bold">안녕하세요! 오늘도 열심히 공부합시다.</h1>
          <p className="text-[#F5F0E8]/50 text-sm mt-1">
            Welcome back{user?.email ? `, ${user.email}` : ''}
            <button onClick={logout} className="ml-4 text-[#F5F0E8]/30 hover:text-[#F5F0E8] text-xs transition-colors">
              Logout
            </button>
          </p>
        </div>

        {/* TOPIK Exam Readiness Cards */}
        <section className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <ReadinessCard
            label="TOPIK I Exam"
            percentage={metrics.topik1Readiness}
            sublabel="Evaluates Level 1 & 2"
            description="Reading (읽기) + Listening (듣기)"
          />
          <ReadinessCard
            label="TOPIK II Exam"
            percentage={metrics.topik2Readiness}
            sublabel="Evaluates Level 3, 4, 5 & 6"
            description="Reading (읽기) + Listening (듣기) + Writing (쓰기)"
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
            sublabel={`of ${metrics.vocabTotal} total`}
          />
          <StatCard
            label="읽기 수준"
            value={metrics.readingLevel}
            sublabel="Reading Level"
          />
          <StatCard
            label="한국어 나이"
            value={metrics.koreanAge > 0 ? `${metrics.koreanAge}세` : '—'}
            sublabel="Korean Age"
          />
        </section>

        {/* Daily Goal Progress */}
        <section className="bg-[#1A1A2E] border border-[#F5F0E8]/10 rounded-lg p-6">
          <div className="flex items-center justify-between mb-3">
            <h3 className="font-semibold">오늘의 목표 | Daily Goal</h3>
            <span className="text-[#F5F0E8]/50 text-sm">
              {metrics.dailyProgress}/{metrics.dailyGoal} min
            </span>
          </div>
          <div className="w-full bg-[#F5F0E8]/10 rounded-full h-3">
            <div
              className="bg-[#C9A84C] h-3 rounded-full transition-all duration-500"
              style={{
                width: `${Math.min(100, (metrics.dailyProgress / metrics.dailyGoal) * 100)}%`,
              }}
            />
          </div>
          {metrics.dailyProgress === 0 && (
            <p className="text-[#F5F0E8]/30 text-xs mt-2">Start studying to track your progress.</p>
          )}
        </section>

        {/* Weak Area Heatmap */}
        <section className="bg-[#1A1A2E] border border-[#F5F0E8]/10 rounded-lg p-6">
          <h3 className="font-semibold mb-4">약점 분석 | Skill Areas</h3>
          {weakAreaData.every((d) => d.score === 0) ? (
            <div className="text-center py-8">
              <p className="text-[#F5F0E8]/30 text-sm">
                Complete lessons and quizzes to see your skill breakdown here.
              </p>
              <Link to="/curriculum" className="text-[#C9A84C] text-sm hover:underline mt-2 inline-block">
                Start learning →
              </Link>
            </div>
          ) : (
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
          )}
        </section>

        {/* Quick Actions */}
        <section>
          <h3 className="font-semibold mb-4">빠른 시작 | Quick Start</h3>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
            {quickActions.map((action) => (
              <Link
                key={action.path}
                to={action.path}
                className="bg-[#1A1A2E] border border-[#F5F0E8]/10 hover:border-[#C9A84C]/50 rounded-lg p-4 text-left transition-colors group"
              >
                <span className="text-2xl block mb-2">{action.icon}</span>
                <span className="font-['Noto_Sans_KR'] text-sm font-semibold block group-hover:text-[#C9A84C] transition-colors">
                  {action.label}
                </span>
                <span className="text-[#F5F0E8]/40 text-xs">{action.sublabel}</span>
              </Link>
            ))}
          </div>
        </section>
      </main>
    </div>
  );
}

/** TOPIK exam readiness percentage card */
function ReadinessCard({
  label,
  percentage,
  sublabel,
  description,
}: {
  label: string;
  percentage: number;
  sublabel: string;
  description: string;
}) {
  return (
    <div className="bg-[#1A1A2E] border border-[#F5F0E8]/10 rounded-lg p-6">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="font-semibold text-lg">{label}</h3>
          <p className="text-[#F5F0E8]/40 text-sm">{sublabel}</p>
          <p className="text-[#F5F0E8]/25 text-xs mt-1">{description}</p>
        </div>
        <div className="text-right">
          <span className="text-3xl font-bold text-[#C9A84C]">{percentage}%</span>
          <p className="text-[#F5F0E8]/40 text-xs">준비도 | Readiness</p>
        </div>
      </div>
      <div className="mt-4 w-full bg-[#F5F0E8]/10 rounded-full h-2">
        <div
          className="bg-[#8B1A1A] h-2 rounded-full transition-all duration-500"
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
    <div className="bg-[#1A1A2E] border border-[#F5F0E8]/10 rounded-lg p-4 text-center">
      <p className="font-['Noto_Sans_KR'] text-sm text-[#F5F0E8]/60 mb-1">{label}</p>
      <p className="text-2xl font-bold text-[#C9A84C]">{value}</p>
      <p className="text-[#F5F0E8]/30 text-xs mt-1">{sublabel}</p>
    </div>
  );
}
