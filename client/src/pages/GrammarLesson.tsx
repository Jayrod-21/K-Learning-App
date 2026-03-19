/**
 * Grammar Lesson Page
 * Displays a single grammar lesson with explanation, examples,
 * practice exercises, and a quiz.
 */
import { useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { getGrammarById, grammarLessons, getGrammarByUnit } from '../data/grammar';
import { getUnitById } from '../data/curriculum';

type Tab = 'explanation' | 'practice' | 'quiz';

export default function GrammarLesson() {
  const { lessonId } = useParams<{ lessonId: string }>();
  const [activeTab, setActiveTab] = useState<Tab>('explanation');
  const [practiceAnswers, setPracticeAnswers] = useState<Map<number, string>>(new Map());
  const [practiceRevealed, setPracticeRevealed] = useState<Set<number>>(new Set());
  const [quizAnswers, setQuizAnswers] = useState<Map<string, number>>(new Map());
  const [quizSubmitted, setQuizSubmitted] = useState(false);

  const lesson = lessonId ? getGrammarById(lessonId) : undefined;

  if (!lesson) {
    return (
      <div className="max-w-4xl mx-auto px-4 py-8 text-center">
        <p className="text-[#a0a0b0] text-lg">Grammar lesson not found.</p>
        <Link to="/grammar" className="text-[#C9A84C] hover:underline mt-4 inline-block">
          ← Browse all grammar lessons
        </Link>
      </div>
    );
  }

  const unit = getUnitById(lesson.unitId);
  const unitLessons = getGrammarByUnit(lesson.unitId);
  const currentIdx = unitLessons.findIndex((l) => l.id === lesson.id);
  const prevLesson = currentIdx > 0 ? unitLessons[currentIdx - 1] : null;
  const nextLesson = currentIdx < unitLessons.length - 1 ? unitLessons[currentIdx + 1] : null;

  /** Find next lesson across all units if at end of current unit */
  const allIdx = grammarLessons.findIndex((l) => l.id === lesson.id);
  const globalNext = allIdx < grammarLessons.length - 1 ? grammarLessons[allIdx + 1] : null;
  const globalPrev = allIdx > 0 ? grammarLessons[allIdx - 1] : null;

  const quizScore = quizSubmitted
    ? lesson.quiz.filter((q) => quizAnswers.get(q.id) === q.correctIndex).length
    : 0;

  const tabs: { key: Tab; label: string; labelKr: string }[] = [
    { key: 'explanation', label: 'Lesson', labelKr: '수업' },
    { key: 'practice', label: 'Practice', labelKr: '연습' },
    { key: 'quiz', label: 'Quiz', labelKr: '퀴즈' },
  ];

  return (
    <div className="max-w-4xl mx-auto px-4 py-8">
      {/* Header */}
      <div className="mb-6">
        {unit && (
          <Link to="/curriculum" className="text-[#C9A84C] text-sm hover:underline">
            Unit {unit.number}: {unit.title}
          </Link>
        )}
        <h1 className="text-2xl font-bold text-[#F5F0E8] mt-1">{lesson.title}</h1>
        <p className="text-[#a0a0b0] font-['Noto_Sans_KR'] text-lg">{lesson.titleKorean}</p>
        <div className="flex gap-2 mt-2">
          <span className="text-xs bg-[#2D5A27]/30 text-[#7db87d] px-2 py-1 rounded-full">
            {lesson.level}
          </span>
          <span className="text-xs bg-[#1f1f32] text-[#C9A84C] px-2 py-1 rounded-full font-mono">
            {lesson.pattern}
          </span>
        </div>
      </div>

      {/* Tab navigation */}
      <div className="flex gap-1 mb-6 bg-[#12121f] rounded-lg p-1">
        {tabs.map((tab) => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className={`flex-1 py-2 px-4 rounded-md text-sm transition-colors ${
              activeTab === tab.key
                ? 'bg-[#8B1A1A] text-white'
                : 'text-[#a0a0b0] hover:text-white hover:bg-[#1f1f32]'
            }`}
          >
            {tab.label} <span className="font-['Noto_Sans_KR'] text-xs opacity-70">({tab.labelKr})</span>
          </button>
        ))}
      </div>

      {/* Explanation tab */}
      {activeTab === 'explanation' && (
        <div className="space-y-6">
          <div className="bg-[#1f1f32] rounded-lg border border-[#2a2a3e] p-6">
            <h2 className="text-[#C9A84C] font-bold text-lg mb-3">Explanation</h2>
            <p className="text-[#F5F0E8] leading-relaxed">{lesson.explanation}</p>
          </div>

          <div className="bg-[#1f1f32] rounded-lg border border-[#2a2a3e] p-6">
            <h2 className="text-[#C9A84C] font-bold text-lg mb-3">Formation Rules</h2>
            <ul className="space-y-2">
              {lesson.formationRules.map((rule, i) => (
                <li key={i} className="text-[#F5F0E8] text-sm flex gap-2">
                  <span className="text-[#C9A84C] flex-shrink-0">→</span>
                  <span className="font-['Noto_Sans_KR']">{rule}</span>
                </li>
              ))}
            </ul>
          </div>

          <div className="bg-[#1f1f32] rounded-lg border border-[#2a2a3e] p-6">
            <h2 className="text-[#C9A84C] font-bold text-lg mb-3">Examples</h2>
            <div className="space-y-3">
              {lesson.examples.map((ex, i) => (
                <div key={i} className="bg-[#16162a] rounded-lg p-4">
                  <p className="text-[#F5F0E8] text-lg font-['Noto_Sans_KR']">
                    {ex.korean.split(ex.highlight).map((part, j, arr) => (
                      <span key={j}>
                        {part}
                        {j < arr.length - 1 && (
                          <span className="text-[#C9A84C] font-bold underline decoration-[#C9A84C]/30">
                            {ex.highlight}
                          </span>
                        )}
                      </span>
                    ))}
                  </p>
                  <p className="text-[#a0a0b0] text-sm mt-1">{ex.english}</p>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Practice tab */}
      {activeTab === 'practice' && (
        <div className="space-y-4">
          <p className="text-[#a0a0b0] text-sm mb-4">
            Fill in the blanks to practice this pattern. Type your answer, then reveal to check.
          </p>
          {lesson.practice.map((p, i) => (
            <div key={i} className="bg-[#1f1f32] rounded-lg border border-[#2a2a3e] p-6">
              <p className="text-[#F5F0E8] font-['Noto_Sans_KR'] text-lg mb-3">{p.prompt}</p>
              <div className="flex gap-3 items-center">
                <input
                  type="text"
                  value={practiceAnswers.get(i) || ''}
                  onChange={(e) => setPracticeAnswers(new Map(practiceAnswers).set(i, e.target.value))}
                  placeholder="Type your answer..."
                  className="flex-1 bg-[#16162a] border border-[#2a2a3e] rounded-lg px-4 py-2
                             text-[#F5F0E8] font-['Noto_Sans_KR'] focus:border-[#C9A84C] focus:outline-none"
                />
                <button
                  onClick={() => setPracticeRevealed(new Set(practiceRevealed).add(i))}
                  className="bg-[#8B1A1A] text-white px-4 py-2 rounded-lg text-sm hover:bg-[#a02020] transition-colors"
                >
                  Reveal
                </button>
              </div>
              {practiceRevealed.has(i) && (
                <div className="mt-3 bg-[#16162a] rounded-lg p-3">
                  <p className="text-[#2D5A27] font-['Noto_Sans_KR']">
                    Answer: <span className="font-bold">{p.answer}</span>
                  </p>
                  <p className="text-[#a0a0b0] text-xs mt-1">{p.hint}</p>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Quiz tab */}
      {activeTab === 'quiz' && (
        <div className="space-y-4">
          {lesson.quiz.map((q, i) => (
            <div key={q.id} className="bg-[#1f1f32] rounded-lg border border-[#2a2a3e] p-6">
              <p className="text-[#F5F0E8] font-semibold mb-3">
                {i + 1}. {q.question}
              </p>
              <div className="space-y-2">
                {q.options.map((opt, optIdx) => {
                  const selected = quizAnswers.get(q.id) === optIdx;
                  const isCorrect = optIdx === q.correctIndex;
                  let optClass = 'bg-[#16162a] border-[#2a2a3e] text-[#F5F0E8] hover:border-[#C9A84C]/50';
                  if (quizSubmitted) {
                    if (isCorrect) optClass = 'bg-[#2D5A27]/20 border-[#2D5A27] text-[#7db87d]';
                    else if (selected) optClass = 'bg-red-900/20 border-red-800 text-red-400';
                  } else if (selected) {
                    optClass = 'bg-[#8B1A1A]/20 border-[#8B1A1A] text-[#F5F0E8]';
                  }

                  return (
                    <button
                      key={optIdx}
                      onClick={() => {
                        if (!quizSubmitted) setQuizAnswers(new Map(quizAnswers).set(q.id, optIdx));
                      }}
                      className={`w-full text-left p-3 rounded-lg border transition-colors ${optClass}`}
                    >
                      <span className="font-['Noto_Sans_KR']">{opt}</span>
                    </button>
                  );
                })}
              </div>
              {quizSubmitted && (
                <p className="text-[#a0a0b0] text-sm mt-3 bg-[#16162a] rounded p-3">
                  {q.explanation}
                </p>
              )}
            </div>
          ))}

          {!quizSubmitted ? (
            <button
              onClick={() => setQuizSubmitted(true)}
              disabled={quizAnswers.size < lesson.quiz.length}
              className="w-full bg-[#8B1A1A] text-white py-3 rounded-lg font-semibold
                         hover:bg-[#a02020] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              Submit Quiz
            </button>
          ) : (
            <div className="bg-[#1f1f32] rounded-lg border border-[#2a2a3e] p-6 text-center">
              <p className="text-2xl font-bold text-[#F5F0E8]">
                Score: {quizScore} / {lesson.quiz.length}
              </p>
              <p className="text-[#a0a0b0] mt-1">
                {quizScore === lesson.quiz.length ? '완벽해요! Perfect!' : '다시 해 봐요! Try again!'}
              </p>
              <button
                onClick={() => {
                  setQuizAnswers(new Map());
                  setQuizSubmitted(false);
                }}
                className="mt-4 bg-[#C9A84C] text-[#1A1A2E] px-6 py-2 rounded-lg font-semibold hover:bg-[#d4b35c]"
              >
                Retry Quiz
              </button>
            </div>
          )}
        </div>
      )}

      {/* Navigation */}
      <div className="flex justify-between mt-8 pt-4 border-t border-[#2a2a3e]">
        {(prevLesson || globalPrev) ? (
          <Link
            to={`/grammar/${(prevLesson || globalPrev)!.id}`}
            className="text-[#C9A84C] hover:underline text-sm"
          >
            ← {(prevLesson || globalPrev)!.title}
          </Link>
        ) : <span />}
        {(nextLesson || globalNext) ? (
          <Link
            to={`/grammar/${(nextLesson || globalNext)!.id}`}
            className="text-[#C9A84C] hover:underline text-sm"
          >
            {(nextLesson || globalNext)!.title} →
          </Link>
        ) : <span />}
      </div>
    </div>
  );
}
