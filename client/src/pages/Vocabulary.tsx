/**
 * Vocabulary Page
 * Flashcard-based vocabulary review using SM-2 spaced repetition.
 * Supports unit filtering and shows vocab in sentence context.
 */
import { useState, useMemo, useCallback } from 'react';
import { useSearchParams, Link } from 'react-router-dom';
import { getVocabByUnit, vocabularyData } from '../data/vocabulary';
import { getAllUnits } from '../data/curriculum';
import { calculateSM2 } from '../utils/sm2';
import type { VocabWord } from '../data/vocabulary';
import type { SM2Card } from '../utils/sm2';

/** Local SM-2 state stored per word (in-memory for now, will persist to Supabase later) */
interface WordReview extends SM2Card {
  wordId: string;
}

/** Quality rating buttons */
const QUALITY_RATINGS = [
  { value: 0, label: 'Again', labelKr: '다시', color: 'bg-red-800 hover:bg-red-700' },
  { value: 2, label: 'Hard', labelKr: '어렵다', color: 'bg-orange-800 hover:bg-orange-700' },
  { value: 3, label: 'Good', labelKr: '보통', color: 'bg-yellow-800 hover:bg-yellow-700' },
  { value: 4, label: 'Easy', labelKr: '쉽다', color: 'bg-green-800 hover:bg-green-700' },
  { value: 5, label: 'Perfect', labelKr: '완벽', color: 'bg-emerald-800 hover:bg-emerald-700' },
];

/** Single flashcard component */
function Flashcard({ word, onRate }: { word: VocabWord; onRate: (quality: number) => void }) {
  const [flipped, setFlipped] = useState(false);

  return (
    <div className="max-w-xl mx-auto">
      <button
        onClick={() => setFlipped(!flipped)}
        className="w-full bg-[#1f1f32] rounded-xl border border-[#2a2a3e] p-8 text-center
                   hover:border-[#C9A84C]/30 transition-all min-h-[300px] flex flex-col justify-center"
      >
        {!flipped ? (
          <>
            <p className="text-4xl font-bold text-[#F5F0E8] font-['Noto_Sans_KR'] mb-4">
              {word.korean}
            </p>
            <div className="bg-[#16162a] rounded-lg p-4 mt-2">
              <p className="text-[#C9A84C] text-lg font-['Noto_Sans_KR']">{word.exampleKorean}</p>
            </div>
            <p className="text-[#a0a0b0] text-sm mt-6">Tap to reveal answer</p>
          </>
        ) : (
          <>
            <p className="text-2xl font-bold text-[#C9A84C] mb-2">{word.english}</p>
            <p className="text-3xl text-[#F5F0E8] font-['Noto_Sans_KR'] mb-4">{word.korean}</p>
            <span className="text-xs bg-[#2D5A27]/30 text-[#7db87d] px-2 py-1 rounded-full mb-4 inline-block">
              {word.partOfSpeech}
            </span>
            <div className="bg-[#16162a] rounded-lg p-4 mt-2 text-left">
              <p className="text-[#F5F0E8] font-['Noto_Sans_KR']">{word.exampleKorean}</p>
              <p className="text-[#a0a0b0] text-sm mt-1">{word.exampleEnglish}</p>
            </div>
          </>
        )}
      </button>

      {flipped && (
        <div className="flex gap-2 mt-4 justify-center flex-wrap">
          {QUALITY_RATINGS.map((rating) => (
            <button
              key={rating.value}
              onClick={() => {
                onRate(rating.value);
                setFlipped(false);
              }}
              className={`${rating.color} text-white px-4 py-2 rounded-lg text-sm transition-colors`}
            >
              <span>{rating.label}</span>
              <span className="block text-xs opacity-70 font-['Noto_Sans_KR']">{rating.labelKr}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Word list view */
function WordList({ words }: { words: VocabWord[] }) {
  return (
    <div className="space-y-2">
      {words.map((word) => (
        <div key={word.id} className="bg-[#1f1f32] rounded-lg border border-[#2a2a3e] p-4">
          <div className="flex items-start justify-between gap-4">
            <div>
              <span className="text-xl font-bold text-[#F5F0E8] font-['Noto_Sans_KR']">{word.korean}</span>
              <span className="text-[#C9A84C] ml-3">{word.english}</span>
              <span className="text-xs bg-[#2a2a3e] text-[#a0a0b0] px-2 py-0.5 rounded-full ml-2">
                {word.partOfSpeech}
              </span>
            </div>
          </div>
          <div className="mt-2 bg-[#16162a] rounded p-3">
            <p className="text-[#F5F0E8] text-sm font-['Noto_Sans_KR']">{word.exampleKorean}</p>
            <p className="text-[#a0a0b0] text-xs mt-1">{word.exampleEnglish}</p>
          </div>
        </div>
      ))}
    </div>
  );
}

export default function Vocabulary() {
  const [searchParams] = useSearchParams();
  const unitFilter = searchParams.get('unit');
  const units = getAllUnits().filter((u) => u.vocabCount > 0);

  const [selectedUnit, setSelectedUnit] = useState(unitFilter || '');
  const [mode, setMode] = useState<'flashcards' | 'list'>('flashcards');
  const [currentIndex, setCurrentIndex] = useState(0);
  const [reviews, setReviews] = useState<Map<string, WordReview>>(new Map());
  const [sessionStats, setSessionStats] = useState({ reviewed: 0, correct: 0 });

  const words = useMemo(() => {
    if (selectedUnit) return getVocabByUnit(selectedUnit);
    return vocabularyData;
  }, [selectedUnit]);

  const handleRate = useCallback((quality: number) => {
    const word = words[currentIndex];
    const existing = reviews.get(word.id) || {
      wordId: word.id,
      interval: 1,
      easiness: 2.5,
      repetitions: 0,
      nextReview: new Date(),
      consecutiveCorrect: 0,
      isMastered: false,
    };

    const updated = calculateSM2(existing, quality);
    setReviews((prev) => new Map(prev).set(word.id, { ...updated, wordId: word.id }));
    setSessionStats((prev) => ({
      reviewed: prev.reviewed + 1,
      correct: quality >= 3 ? prev.correct + 1 : prev.correct,
    }));
    setCurrentIndex((prev) => (prev + 1) % words.length);
  }, [words, currentIndex, reviews]);

  if (words.length === 0) {
    return (
      <div className="max-w-4xl mx-auto px-4 py-8 text-center">
        <p className="text-[#a0a0b0]">No vocabulary available for this unit yet.</p>
        <Link to="/curriculum" className="text-[#C9A84C] hover:underline mt-2 inline-block">
          ← Back to Curriculum
        </Link>
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto px-4 py-8">
      <div className="flex items-center justify-between mb-6 flex-wrap gap-4">
        <div>
          <h1 className="text-3xl font-bold text-[#F5F0E8] font-['Noto_Sans_KR']">단어 학습</h1>
          <p className="text-[#a0a0b0] mt-1">Vocabulary Study — {words.length} words</p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => setMode('flashcards')}
            className={`px-4 py-2 rounded-lg text-sm transition-colors ${
              mode === 'flashcards' ? 'bg-[#8B1A1A] text-white' : 'bg-[#1f1f32] text-[#a0a0b0] hover:text-white'
            }`}
          >
            Flashcards
          </button>
          <button
            onClick={() => setMode('list')}
            className={`px-4 py-2 rounded-lg text-sm transition-colors ${
              mode === 'list' ? 'bg-[#8B1A1A] text-white' : 'bg-[#1f1f32] text-[#a0a0b0] hover:text-white'
            }`}
          >
            Word List
          </button>
        </div>
      </div>

      {/* Unit filter */}
      <div className="mb-6">
        <select
          value={selectedUnit}
          onChange={(e) => { setSelectedUnit(e.target.value); setCurrentIndex(0); }}
          className="bg-[#1f1f32] text-[#F5F0E8] border border-[#2a2a3e] rounded-lg px-4 py-2 text-sm"
        >
          <option value="">All Units</option>
          {units.map((u) => (
            <option key={u.id} value={u.id}>
              Unit {u.number}: {u.title} ({u.titleKorean})
            </option>
          ))}
        </select>
      </div>

      {mode === 'flashcards' ? (
        <>
          {/* Session stats */}
          <div className="flex gap-4 mb-6 text-sm">
            <span className="text-[#a0a0b0]">
              Card {currentIndex + 1} / {words.length}
            </span>
            <span className="text-[#a0a0b0]">
              Reviewed: <span className="text-[#F5F0E8]">{sessionStats.reviewed}</span>
            </span>
            <span className="text-[#a0a0b0]">
              Correct: <span className="text-[#2D5A27]">{sessionStats.correct}</span>
            </span>
          </div>

          {/* Progress bar */}
          <div className="w-full bg-[#1f1f32] rounded-full h-1.5 mb-6">
            <div
              className="bg-[#C9A84C] h-1.5 rounded-full transition-all"
              style={{ width: `${((currentIndex + 1) / words.length) * 100}%` }}
            />
          </div>

          <Flashcard word={words[currentIndex]} onRate={handleRate} />
        </>
      ) : (
        <WordList words={words} />
      )}
    </div>
  );
}
