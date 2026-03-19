/**
 * Reading Practice Page
 * Graded reading passages with tap-to-translate and comprehension questions.
 * Includes built-in passages and AI-generated passage support.
 */
import { useState } from 'react';

interface ReadingPassage {
  id: string;
  title: string;
  titleEnglish: string;
  level: string;
  content: string;
  translation: string;
  vocabulary: { korean: string; english: string }[];
  questions: { question: string; options: string[]; correctIndex: number; explanation: string }[];
}

const builtInPassages: ReadingPassage[] = [
  {
    id: 'r1',
    title: '자기소개',
    titleEnglish: 'Self-Introduction',
    level: 'beginner',
    content: '안녕하세요. 저는 김민수입니다. 저는 미국에서 왔어요. 지금 서울에서 한국어를 공부하고 있어요. 저는 대학생이에요. 한국 음식을 좋아해요. 특히 비빔밥과 김치를 좋아해요. 한국어는 어렵지만 재미있어요. 매일 열심히 공부해요. 한국 친구도 많이 사귀고 싶어요. 만나서 반갑습니다!',
    translation: 'Hello. My name is Kim Minsu. I came from America. I am currently studying Korean in Seoul. I am a university student. I like Korean food. I especially like bibimbap and kimchi. Korean is difficult but fun. I study hard every day. I also want to make many Korean friends. Nice to meet you!',
    vocabulary: [
      { korean: '특히', english: 'especially' },
      { korean: '어렵다', english: 'to be difficult' },
      { korean: '재미있다', english: 'to be fun/interesting' },
      { korean: '열심히', english: 'hard/diligently' },
      { korean: '사귀다', english: 'to make friends/date' },
    ],
    questions: [
      { question: '김민수는 어디에서 왔어요?', options: ['한국', '미국', '일본', '중국'], correctIndex: 1, explanation: '"저는 미국에서 왔어요" — He came from America.' },
      { question: '김민수는 뭐를 좋아해요?', options: ['일본 음식', '한국 음식', '중국 음식', '미국 음식'], correctIndex: 1, explanation: '"한국 음식을 좋아해요" — He likes Korean food.' },
      { question: '한국어가 어때요?', options: ['쉬워요', '어렵지만 재미있어요', '재미없어요', '너무 쉬워요'], correctIndex: 1, explanation: '"한국어는 어렵지만 재미있어요" — Korean is difficult but fun.' },
    ],
  },
  {
    id: 'r2',
    title: '나의 하루',
    titleEnglish: 'My Day',
    level: 'beginner',
    content: '저는 매일 아침 일곱 시에 일어나요. 먼저 세수하고 아침을 먹어요. 보통 빵과 우유를 먹어요. 여덟 시에 학교에 가요. 버스로 삼십 분 걸려요. 학교에서 열두 시까지 수업을 들어요. 점심에는 학교 식당에서 밥을 먹어요. 오후에는 도서관에서 공부해요. 다섯 시에 집에 와요. 저녁에는 텔레비전을 보거나 음악을 들어요. 열한 시에 자요.',
    translation: 'I wake up at 7 every morning. First I wash my face and eat breakfast. I usually eat bread and milk. I go to school at 8. It takes 30 minutes by bus. I attend classes until 12 at school. For lunch, I eat at the school cafeteria. In the afternoon, I study at the library. I come home at 5. In the evening, I watch TV or listen to music. I sleep at 11.',
    vocabulary: [
      { korean: '먼저', english: 'first' },
      { korean: '세수하다', english: 'to wash one\'s face' },
      { korean: '걸리다', english: 'to take (time)' },
      { korean: '수업을 듣다', english: 'to attend class' },
      { korean: '오후', english: 'afternoon' },
    ],
    questions: [
      { question: '몇 시에 일어나요?', options: ['여섯 시', '일곱 시', '여덟 시', '아홉 시'], correctIndex: 1, explanation: '"매일 아침 일곱 시에 일어나요" — Wakes up at 7.' },
      { question: '학교에 어떻게 가요?', options: ['걸어서', '지하철로', '버스로', '택시로'], correctIndex: 2, explanation: '"버스로 삼십 분 걸려요" — Goes by bus.' },
      { question: '오후에 뭐 해요?', options: ['텔레비전을 봐요', '도서관에서 공부해요', '운동해요', '친구를 만나요'], correctIndex: 1, explanation: '"오후에는 도서관에서 공부해요" — Studies at the library.' },
    ],
  },
  {
    id: 'r3',
    title: '한국 식당에서',
    titleEnglish: 'At a Korean Restaurant',
    level: 'beginner',
    content: '오늘 친구와 같이 한국 식당에 갔어요. 식당에 사람이 많았어요. 우리는 불고기와 된장찌개를 주문했어요. 반찬도 많이 나왔어요. 김치, 콩나물, 시금치가 있었어요. 불고기는 정말 맛있었어요! 된장찌개도 맛있었지만 좀 짰어요. 밥도 두 공기 먹었어요. 배가 너무 불렀어요. 계산은 제가 했어요. 만사천 원이었어요. 다음에 또 오고 싶어요.',
    translation: 'Today I went to a Korean restaurant with my friend. There were many people at the restaurant. We ordered bulgogi and doenjang jjigae. Many side dishes came out too. There was kimchi, bean sprouts, and spinach. The bulgogi was really delicious! The doenjang jjigae was also tasty but a bit salty. I ate two bowls of rice too. I was very full. I paid the bill. It was 14,000 won. I want to come again next time.',
    vocabulary: [
      { korean: '된장찌개', english: 'doenjang jjigae (soybean paste stew)' },
      { korean: '반찬', english: 'side dishes' },
      { korean: '콩나물', english: 'bean sprouts' },
      { korean: '시금치', english: 'spinach' },
      { korean: '공기', english: 'bowl (of rice)' },
    ],
    questions: [
      { question: '뭐를 주문했어요?', options: ['비빔밥과 김치찌개', '불고기와 된장찌개', '라면과 김밥', '삼겹살과 냉면'], correctIndex: 1, explanation: '"불고기와 된장찌개를 주문했어요" — Ordered bulgogi and doenjang jjigae.' },
      { question: '된장찌개가 어땠어요?', options: ['매웠어요', '맛없었어요', '맛있었지만 짰어요', '아주 좋았어요'], correctIndex: 2, explanation: '"된장찌개도 맛있었지만 좀 짰어요" — Tasty but a bit salty.' },
      { question: '얼마였어요?', options: ['만원', '만이천 원', '만사천 원', '이만 원'], correctIndex: 2, explanation: '"만사천 원이었어요" — It was 14,000 won.' },
    ],
  },
];

export default function Reading() {
  const [selectedPassage, setSelectedPassage] = useState<ReadingPassage | null>(null);
  const [showTranslation, setShowTranslation] = useState(false);
  const [showVocab, setShowVocab] = useState(false);
  const [quizAnswers, setQuizAnswers] = useState<Map<number, number>>(new Map());
  const [quizSubmitted, setQuizSubmitted] = useState(false);

  if (!selectedPassage) {
    return (
      <div className="max-w-4xl mx-auto px-4 py-8">
        <div className="mb-8">
          <h1 className="text-3xl font-bold text-[#F5F0E8] font-['Noto_Sans_KR']">읽기 연습</h1>
          <p className="text-[#a0a0b0] mt-1">Reading Practice — Choose a passage to read</p>
        </div>

        <div className="space-y-3">
          {builtInPassages.map((passage) => (
            <button
              key={passage.id}
              onClick={() => {
                setSelectedPassage(passage);
                setShowTranslation(false);
                setShowVocab(false);
                setQuizAnswers(new Map());
                setQuizSubmitted(false);
              }}
              className="w-full text-left bg-[#1f1f32] rounded-lg border border-[#2a2a3e] p-5
                         hover:border-[#C9A84C]/30 transition-colors group"
            >
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="text-[#F5F0E8] font-semibold text-lg group-hover:text-[#C9A84C] transition-colors font-['Noto_Sans_KR']">
                    {passage.title}
                  </h3>
                  <p className="text-[#a0a0b0] text-sm">{passage.titleEnglish}</p>
                </div>
                <div className="flex gap-2 items-center">
                  <span className="text-xs bg-blue-900/30 text-blue-300 px-2 py-1 rounded-full">
                    {passage.level}
                  </span>
                  <span className="text-xs text-[#a0a0b0]">
                    {passage.questions.length} questions
                  </span>
                  <span className="text-[#a0a0b0] group-hover:text-[#C9A84C]">→</span>
                </div>
              </div>
            </button>
          ))}
        </div>
      </div>
    );
  }

  const quizScore = quizSubmitted
    ? selectedPassage.questions.filter((_, i) => quizAnswers.get(i) === selectedPassage.questions[i].correctIndex).length
    : 0;

  return (
    <div className="max-w-4xl mx-auto px-4 py-8">
      <button
        onClick={() => setSelectedPassage(null)}
        className="text-[#C9A84C] hover:underline text-sm mb-4 inline-block"
      >
        ← Back to passages
      </button>

      <div className="mb-6">
        <h1 className="text-2xl font-bold text-[#F5F0E8] font-['Noto_Sans_KR']">{selectedPassage.title}</h1>
        <p className="text-[#a0a0b0]">{selectedPassage.titleEnglish}</p>
      </div>

      {/* Reading passage */}
      <div className="bg-[#1f1f32] rounded-lg border border-[#2a2a3e] p-6 mb-6">
        <p className="text-[#F5F0E8] text-lg leading-relaxed font-['Noto_Sans_KR'] whitespace-pre-wrap">
          {selectedPassage.content}
        </p>

        {showTranslation && (
          <div className="mt-4 pt-4 border-t border-[#2a2a3e]">
            <p className="text-[#a0a0b0] leading-relaxed">{selectedPassage.translation}</p>
          </div>
        )}
      </div>

      {/* Controls */}
      <div className="flex gap-3 mb-6">
        <button
          onClick={() => setShowTranslation(!showTranslation)}
          className={`px-4 py-2 rounded-lg text-sm transition-colors ${
            showTranslation ? 'bg-[#8B1A1A] text-white' : 'bg-[#1f1f32] text-[#a0a0b0] hover:text-white'
          }`}
        >
          {showTranslation ? 'Hide Translation' : 'Show Translation'}
        </button>
        <button
          onClick={() => setShowVocab(!showVocab)}
          className={`px-4 py-2 rounded-lg text-sm transition-colors ${
            showVocab ? 'bg-[#8B1A1A] text-white' : 'bg-[#1f1f32] text-[#a0a0b0] hover:text-white'
          }`}
        >
          {showVocab ? 'Hide Vocabulary' : 'Key Vocabulary'}
        </button>
      </div>

      {/* Vocabulary */}
      {showVocab && (
        <div className="bg-[#1f1f32] rounded-lg border border-[#2a2a3e] p-4 mb-6">
          <h3 className="text-[#C9A84C] font-bold mb-3">Key Vocabulary</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
            {selectedPassage.vocabulary.map((v, i) => (
              <div key={i} className="flex gap-3 bg-[#16162a] rounded p-2">
                <span className="text-[#F5F0E8] font-['Noto_Sans_KR'] font-semibold">{v.korean}</span>
                <span className="text-[#a0a0b0]">{v.english}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Comprehension questions */}
      <div className="space-y-4">
        <h3 className="text-[#C9A84C] font-bold text-lg font-['Noto_Sans_KR']">이해력 문제 (Comprehension)</h3>
        {selectedPassage.questions.map((q, i) => (
          <div key={i} className="bg-[#1f1f32] rounded-lg border border-[#2a2a3e] p-5">
            <p className="text-[#F5F0E8] font-['Noto_Sans_KR'] font-semibold mb-3">
              {i + 1}. {q.question}
            </p>
            <div className="space-y-2">
              {q.options.map((opt, optIdx) => {
                const selected = quizAnswers.get(i) === optIdx;
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
                      if (!quizSubmitted) setQuizAnswers(new Map(quizAnswers).set(i, optIdx));
                    }}
                    className={`w-full text-left p-3 rounded-lg border transition-colors font-['Noto_Sans_KR'] ${optClass}`}
                  >
                    {opt}
                  </button>
                );
              })}
            </div>
            {quizSubmitted && (
              <p className="text-[#a0a0b0] text-sm mt-3 bg-[#16162a] rounded p-3">{q.explanation}</p>
            )}
          </div>
        ))}

        {!quizSubmitted ? (
          <button
            onClick={() => setQuizSubmitted(true)}
            disabled={quizAnswers.size < selectedPassage.questions.length}
            className="w-full bg-[#8B1A1A] text-white py-3 rounded-lg font-semibold
                       hover:bg-[#a02020] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            Check Answers
          </button>
        ) : (
          <div className="bg-[#1f1f32] rounded-lg border border-[#2a2a3e] p-6 text-center">
            <p className="text-2xl font-bold text-[#F5F0E8]">
              {quizScore} / {selectedPassage.questions.length}
            </p>
            <p className="text-[#a0a0b0] mt-1">
              {quizScore === selectedPassage.questions.length ? '완벽해요! Perfect!' : '괜찮아요! Keep practicing!'}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
