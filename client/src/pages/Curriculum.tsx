/**
 * Curriculum Page
 * Displays the full course structure organized by phases and units.
 * Users can see their progress and navigate to specific lessons.
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { curriculum } from '../data/curriculum';
import type { Unit, Lesson } from '../data/curriculum';

/** Badge for lesson type */
function LessonBadge({ type }: { type: Lesson['type'] }) {
  const styles: Record<string, string> = {
    vocab: 'bg-blue-900/50 text-blue-300',
    grammar: 'bg-green-900/50 text-green-300',
    reading: 'bg-purple-900/50 text-purple-300',
    quiz: 'bg-yellow-900/50 text-yellow-300',
    culture: 'bg-pink-900/50 text-pink-300',
  };
  const labels: Record<string, string> = {
    vocab: '단어',
    grammar: '문법',
    reading: '읽기',
    quiz: '퀴즈',
    culture: '문화',
  };
  return (
    <span className={`text-xs px-2 py-0.5 rounded-full ${styles[type]}`}>
      {labels[type]}
    </span>
  );
}

/** Get the link path for a lesson */
function getLessonPath(lesson: Lesson, unit: Unit): string {
  if (lesson.type === 'vocab') return `/vocab?unit=${unit.id}`;
  if (lesson.type === 'grammar') return `/grammar/${lesson.id}`;
  if (lesson.type === 'quiz') return `/grammar/${lesson.id}`;
  if (lesson.type === 'reading') return `/reading?unit=${unit.id}`;
  return `/curriculum`;
}

/** Expandable unit card */
function UnitCard({ unit }: { unit: Unit }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="bg-[#1f1f32] rounded-lg border border-[#2a2a3e] overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full text-left p-4 hover:bg-[#252540] transition-colors"
      >
        <div className="flex items-center justify-between">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <span className="text-[#C9A84C] font-bold text-sm">Unit {unit.number}</span>
              {unit.topikLevel !== 'pre' && (
                <span className={`text-xs px-2 py-0.5 rounded-full ${
                  unit.topikLevel === 'topik1'
                    ? 'bg-[#8B1A1A]/30 text-[#e88]'
                    : 'bg-purple-900/30 text-purple-300'
                }`}>
                  {unit.topikLevel === 'topik1' ? 'TOPIK I' : 'TOPIK II'}
                </span>
              )}
            </div>
            <h3 className="text-[#F5F0E8] font-semibold text-lg">{unit.title}</h3>
            <p className="text-[#F5F0E8]/70 font-['Noto_Sans_KR'] text-sm">{unit.titleKorean}</p>
          </div>
          <div className="text-right flex-shrink-0 ml-4">
            <div className="text-[#a0a0b0] text-xs">
              {unit.vocabCount > 0 && <span>{unit.vocabCount} words</span>}
            </div>
            <div className="text-[#a0a0b0] text-xs">{unit.lessons.length} lessons</div>
            <span className="text-[#a0a0b0] text-lg">{expanded ? '▲' : '▼'}</span>
          </div>
        </div>
        <p className="text-[#a0a0b0] text-sm mt-2">{unit.description}</p>
        {unit.grammarPatterns.length > 0 && (
          <div className="flex flex-wrap gap-1 mt-2">
            {unit.grammarPatterns.map((p, i) => (
              <span key={i} className="text-xs bg-[#2D5A27]/30 text-[#7db87d] px-2 py-0.5 rounded">
                {p}
              </span>
            ))}
          </div>
        )}
      </button>

      {expanded && (
        <div className="border-t border-[#2a2a3e] p-4">
          <div className="space-y-2">
            {unit.lessons.map((lesson, idx) => (
              <Link
                key={lesson.id}
                to={getLessonPath(lesson, unit)}
                className="flex items-center gap-3 p-3 rounded-md bg-[#16162a] hover:bg-[#1a1a30] transition-colors group"
              >
                <span className="text-[#a0a0b0] text-sm w-6">{idx + 1}.</span>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-[#F5F0E8] text-sm group-hover:text-[#C9A84C] transition-colors">
                      {lesson.title}
                    </span>
                    <LessonBadge type={lesson.type} />
                  </div>
                  <p className="text-[#a0a0b0] text-xs mt-0.5 font-['Noto_Sans_KR']">{lesson.titleKorean}</p>
                </div>
                <span className="text-[#a0a0b0] text-sm opacity-0 group-hover:opacity-100 transition-opacity">→</span>
              </Link>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export default function Curriculum() {
  return (
    <div className="max-w-4xl mx-auto px-4 py-8">
      <div className="mb-8">
        <h1 className="text-3xl font-bold text-[#F5F0E8] font-['Noto_Sans_KR']">교육과정</h1>
        <p className="text-[#a0a0b0] mt-1">Course Curriculum — From zero to TOPIK II</p>
      </div>

      {curriculum.map((phase) => (
        <div key={phase.id} className="mb-10">
          <div className="mb-4 pb-2 border-b border-[#2a2a3e]">
            <div className="flex items-center gap-3">
              <span className="text-[#C9A84C] font-bold text-sm uppercase tracking-wider">
                Phase {phase.number}
              </span>
              <span className="text-xs bg-[#8B1A1A]/20 text-[#e88] px-2 py-0.5 rounded-full">
                {phase.topikTarget}
              </span>
            </div>
            <h2 className="text-xl font-bold text-[#F5F0E8] mt-1">
              {phase.title}
              <span className="text-[#a0a0b0] font-normal ml-2 font-['Noto_Sans_KR']">
                {phase.titleKorean}
              </span>
            </h2>
            <p className="text-[#a0a0b0] text-sm mt-1">{phase.description}</p>
          </div>

          <div className="space-y-3">
            {phase.units.map((unit) => (
              <UnitCard key={unit.id} unit={unit} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
