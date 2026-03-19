/**
 * Grammar List Page
 * Browse all grammar lessons organized by unit.
 */
import { Link } from 'react-router-dom';
import { grammarLessons } from '../data/grammar';
import { getAllUnits } from '../data/curriculum';

export default function GrammarList() {
  const units = getAllUnits();
  const unitMap = new Map(units.map((u) => [u.id, u]));

  /** Group lessons by unit */
  const grouped = grammarLessons.reduce<Record<string, typeof grammarLessons>>((acc, lesson) => {
    if (!acc[lesson.unitId]) acc[lesson.unitId] = [];
    acc[lesson.unitId].push(lesson);
    return acc;
  }, {});

  const levelColors: Record<string, string> = {
    beginner: 'bg-blue-900/30 text-blue-300',
    topik1: 'bg-green-900/30 text-green-300',
    topik2: 'bg-purple-900/30 text-purple-300',
  };

  return (
    <div className="max-w-4xl mx-auto px-4 py-8">
      <div className="mb-8">
        <h1 className="text-3xl font-bold text-[#F5F0E8] font-['Noto_Sans_KR']">문법 수업</h1>
        <p className="text-[#a0a0b0] mt-1">Grammar Lessons — {grammarLessons.length} lessons available</p>
      </div>

      {Object.entries(grouped).map(([unitId, lessons]) => {
        const unit = unitMap.get(unitId);
        if (!unit) return null;

        return (
          <div key={unitId} className="mb-8">
            <div className="mb-3 flex items-center gap-2">
              <span className="text-[#C9A84C] font-bold text-sm">Unit {unit.number}</span>
              <span className="text-[#F5F0E8] font-semibold">{unit.title}</span>
              <span className="text-[#a0a0b0] font-['Noto_Sans_KR'] text-sm">{unit.titleKorean}</span>
            </div>

            <div className="space-y-2">
              {lessons.map((lesson) => (
                <Link
                  key={lesson.id}
                  to={`/grammar/${lesson.id}`}
                  className="block bg-[#1f1f32] rounded-lg border border-[#2a2a3e] p-4
                             hover:border-[#C9A84C]/30 transition-colors group"
                >
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <h3 className="text-[#F5F0E8] font-semibold group-hover:text-[#C9A84C] transition-colors">
                        {lesson.title}
                      </h3>
                      <p className="text-[#a0a0b0] font-['Noto_Sans_KR'] text-sm mt-0.5">
                        {lesson.titleKorean}
                      </p>
                    </div>
                    <div className="flex gap-2 flex-shrink-0">
                      <span className={`text-xs px-2 py-0.5 rounded-full ${levelColors[lesson.level]}`}>
                        {lesson.level}
                      </span>
                    </div>
                  </div>
                  <div className="mt-2">
                    <span className="text-xs font-mono bg-[#16162a] text-[#C9A84C] px-2 py-1 rounded">
                      {lesson.pattern}
                    </span>
                  </div>
                  <p className="text-[#a0a0b0] text-sm mt-2 line-clamp-2">{lesson.explanation}</p>
                  <div className="flex gap-3 mt-2 text-xs text-[#a0a0b0]">
                    <span>{lesson.examples.length} examples</span>
                    <span>{lesson.practice.length} practice</span>
                    <span>{lesson.quiz.length} quiz questions</span>
                  </div>
                </Link>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
