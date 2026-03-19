/**
 * Grammar Lessons Data
 * Structured grammar content with explanations, examples, practice, and quizzes.
 * Each lesson maps to a specific unit and covers one grammar pattern.
 */

export interface GrammarExample {
  korean: string;
  english: string;
  highlight: string;
}

export interface PracticeSentence {
  prompt: string;
  answer: string;
  hint: string;
}

export interface QuizQuestion {
  id: string;
  question: string;
  options: string[];
  correctIndex: number;
  explanation: string;
}

export interface GrammarLesson {
  id: string;
  unitId: string;
  title: string;
  titleKorean: string;
  pattern: string;
  level: 'beginner' | 'topik1' | 'topik2';
  explanation: string;
  formationRules: string[];
  examples: GrammarExample[];
  practice: PracticeSentence[];
  quiz: QuizQuestion[];
}

export const grammarLessons: GrammarLesson[] = [
  // ===== UNIT 1: Greetings & Introductions =====
  {
    id: 'g1-01',
    unitId: 'unit-1',
    title: 'The Copula: 이다 (to be)',
    titleKorean: '이다',
    pattern: 'Noun + 이에요/예요',
    level: 'beginner',
    explanation: 'In Korean, "이다" means "to be." Unlike English, it attaches directly to nouns. Use "이에요" after consonant-ending nouns and "예요" after vowel-ending nouns. This is the informal polite form (-요) used in everyday conversation.',
    formationRules: [
      'After a consonant: Noun + 이에요 → 학생이에요 (I am a student)',
      'After a vowel: Noun + 예요 → 의사예요 (I am a doctor)',
      'Formal version: Noun + 입니다 → 학생입니다 (I am a student, formal)',
      'Negative: Noun + 이/가 아니에요 → 학생이 아니에요 (I am not a student)',
    ],
    examples: [
      { korean: '저는 학생이에요.', english: 'I am a student.', highlight: '이에요' },
      { korean: '이것은 책이에요.', english: 'This is a book.', highlight: '이에요' },
      { korean: '저는 미국 사람이에요.', english: 'I am an American.', highlight: '이에요' },
      { korean: '여기는 도서관이에요.', english: 'This place is a library.', highlight: '이에요' },
      { korean: '그분은 선생님이에요.', english: 'That person is a teacher.', highlight: '이에요' },
      { korean: '저는 의사예요.', english: 'I am a doctor.', highlight: '예요' },
      { korean: '이것은 커피예요.', english: 'This is coffee.', highlight: '예요' },
    ],
    practice: [
      { prompt: 'I am a student. → 저는 _____.', answer: '학생이에요', hint: '학생 ends in a consonant → 이에요' },
      { prompt: 'This is coffee. → 이것은 _____.', answer: '커피예요', hint: '커피 ends in a vowel → 예요' },
      { prompt: 'I am not a teacher. → 저는 선생님이 _____.', answer: '아니에요', hint: 'Negative form: 이/가 아니에요' },
    ],
    quiz: [
      { id: 'g1-01-q1', question: 'How do you say "I am a student" politely?', options: ['저는 학생이에요', '저는 학생예요', '저는 학생이다', '저는 학생에요'], correctIndex: 0, explanation: '학생 ends in ㅇ (consonant), so use 이에요: 학생이에요' },
      { id: 'g1-01-q2', question: 'Fill in the blank: 이것은 커피_____.', options: ['이에요', '예요', '이다', '에요'], correctIndex: 1, explanation: '커피 ends in ㅣ (vowel), so use 예요' },
      { id: 'g1-01-q3', question: 'How do you say "I am NOT American"?', options: ['저는 미국 사람이에요', '저는 미국 사람이 아니에요', '저는 미국 사람 없어요', '저는 미국 사람 아니다'], correctIndex: 1, explanation: 'Negative copula: Noun + 이/가 아니에요' },
    ],
  },
  {
    id: 'g1-02',
    unitId: 'unit-1',
    title: 'Formal Speech: -입니다',
    titleKorean: '입니다',
    pattern: 'Noun + 입니다',
    level: 'beginner',
    explanation: 'The formal polite ending "-입니다" (and question form "-입니까?") is used in formal settings: business, presentations, news, and when speaking to people much older or higher in status. It attaches to nouns the same way as 이에요/예요 but is more formal.',
    formationRules: [
      'Statement: Noun + 입니다 → 학생입니다 (I am a student)',
      'Question: Noun + 입니까? → 학생입니까? (Are you a student?)',
      'Negative: Noun + 이/가 아닙니다 → 학생이 아닙니다 (I am not a student)',
      'Used in: business settings, formal introductions, presentations, news',
    ],
    examples: [
      { korean: '저는 김민수입니다.', english: 'I am Kim Minsu.', highlight: '입니다' },
      { korean: '만나서 반갑습니다.', english: 'Nice to meet you.', highlight: '반갑습니다' },
      { korean: '처음 뵙겠습니다.', english: 'How do you do (very formal).', highlight: '뵙겠습니다' },
      { korean: '한국 사람입니까?', english: 'Are you Korean?', highlight: '입니까' },
    ],
    practice: [
      { prompt: 'I am Kim Jared. (formal) → 저는 김재러드_____.', answer: '입니다', hint: 'Formal ending for "is/am"' },
      { prompt: 'Are you a teacher? (formal) → 선생님___?', answer: '입니까', hint: 'Formal question form' },
    ],
    quiz: [
      { id: 'g1-02-q1', question: 'Which is MORE formal?', options: ['학생이에요', '학생입니다', '학생이야', '학생이다'], correctIndex: 1, explanation: '-입니다 is the most formal polite form. -이에요 is informal polite. -이야 is casual.' },
      { id: 'g1-02-q2', question: 'When would you use -입니다?', options: ['Talking to friends', 'Business meeting', 'Texting family', 'Thinking to yourself'], correctIndex: 1, explanation: '-입니다 is used in formal settings like business, presentations, and news.' },
    ],
  },

  // ===== UNIT 2: Basic Sentences =====
  {
    id: 'g2-01',
    unitId: 'unit-2',
    title: 'Topic & Subject Particles: 은/는, 이/가',
    titleKorean: '은/는, 이/가',
    pattern: 'Noun + 은/는 (topic) | Noun + 이/가 (subject)',
    level: 'beginner',
    explanation: '은/는 marks the TOPIC of the sentence — what you\'re talking about. 이/가 marks the SUBJECT — who/what does the action or is being described. Use 은/는 for contrast, general statements, and introducing topics. Use 이/가 for new information, emphasis, and with 있다/없다.',
    formationRules: [
      'After consonant: 은 (topic), 이 (subject) → 책은, 책이',
      'After vowel: 는 (topic), 가 (subject) → 커피는, 커피가',
      '은/는 = "As for..." / 이/가 = "It is... that..."',
      '이/가 is used with 있다/없다, 좋다/싫다, and for new information',
    ],
    examples: [
      { korean: '저는 학생이에요.', english: 'I (as for me) am a student.', highlight: '는' },
      { korean: '날씨가 좋아요.', english: 'The weather is good. (new info)', highlight: '가' },
      { korean: '한국어는 재미있어요.', english: 'Korean (as a topic) is fun.', highlight: '는' },
      { korean: '누가 했어요?', english: 'Who did it?', highlight: '가' },
      { korean: '저는 커피는 좋아해요. 차는 싫어해요.', english: 'I like coffee. (But) I don\'t like tea.', highlight: '는' },
    ],
    practice: [
      { prompt: 'I am a student. → 저___ 학생이에요.', answer: '는', hint: '"I" is the topic of the sentence' },
      { prompt: 'The weather is good. → 날씨___ 좋아요.', answer: '가', hint: 'Weather is new information being described' },
      { prompt: 'What is this? → 이것___ 뭐예요?', answer: '은', hint: '"This thing" is the topic being asked about' },
    ],
    quiz: [
      { id: 'g2-01-q1', question: '저___ 학생이에요. Fill in the particle.', options: ['은', '는', '이', '가'], correctIndex: 1, explanation: '저 ends in a vowel (ㅓ), so use 는. Also, "I" is the topic.' },
      { id: 'g2-01-q2', question: '날씨___ 좋아요. Which particle?', options: ['은', '는', '이', '가'], correctIndex: 3, explanation: '날씨 ends in a vowel, so use 가. Weather is being described (subject).' },
      { id: 'g2-01-q3', question: 'When do you use 이/가 instead of 은/는?', options: ['For the topic', 'For contrast', 'For new information or with 있다/없다', 'Always'], correctIndex: 2, explanation: '이/가 marks new information, answers to questions, and is used with 있다/없다.' },
    ],
  },
  {
    id: 'g2-02',
    unitId: 'unit-2',
    title: 'Object Particle & Existence: 을/를, 있다/없다',
    titleKorean: '을/를, 있다/없다',
    pattern: 'Noun + 을/를 (object) | Noun + 이/가 있다/없다 (existence)',
    level: 'beginner',
    explanation: '을/를 marks the OBJECT of an action — what is being done to. Use 을 after consonants, 를 after vowels. 있다 means "to exist/to have" and 없다 means "to not exist/to not have." They always use 이/가 for the subject.',
    formationRules: [
      'After consonant: 을 → 책을 읽다 (to read a book)',
      'After vowel: 를 → 커피를 마시다 (to drink coffee)',
      'Existence: Noun + 이/가 있어요 → 시간이 있어요 (I have time)',
      'Non-existence: Noun + 이/가 없어요 → 돈이 없어요 (I don\'t have money)',
    ],
    examples: [
      { korean: '책을 읽어요.', english: 'I read a book.', highlight: '을' },
      { korean: '커피를 마셔요.', english: 'I drink coffee.', highlight: '를' },
      { korean: '시간이 있어요.', english: 'I have time.', highlight: '있어요' },
      { korean: '돈이 없어요.', english: 'I don\'t have money.', highlight: '없어요' },
      { korean: '책상 위에 책이 있어요.', english: 'There is a book on the desk.', highlight: '있어요' },
    ],
    practice: [
      { prompt: 'I read a book. → 책___ 읽어요.', answer: '을', hint: '책 ends in ㄱ (consonant) → 을' },
      { prompt: 'I drink coffee. → 커피___ 마셔요.', answer: '를', hint: '커피 ends in ㅣ (vowel) → 를' },
      { prompt: 'I have time. → 시간이 _____.', answer: '있어요', hint: 'To have/exist = 있다' },
    ],
    quiz: [
      { id: 'g2-02-q1', question: '물___ 마셔요. Which particle?', options: ['을', '를', '이', '가'], correctIndex: 1, explanation: '물 ends in ㄹ (consonant), but 를 is used after 물... Actually 물 ends in ㄹ which is a consonant, so 을. But in casual speech 를 is sometimes used.' },
      { id: 'g2-02-q2', question: 'How do you say "I don\'t have money"?', options: ['돈이 있어요', '돈이 없어요', '돈을 없어요', '돈은 있어요'], correctIndex: 1, explanation: 'Use 이/가 (not 을/를) with 없다. 돈이 없어요.' },
    ],
  },

  // ===== UNIT 4: Daily Life =====
  {
    id: 'g4-01',
    unitId: 'unit-4',
    title: 'Present Tense: -아/어요',
    titleKorean: '현재형 -아/어요',
    pattern: 'Verb stem + -아요/어요',
    level: 'beginner',
    explanation: 'The informal polite present tense ending -아요/어요 is the most common verb form in daily Korean. Choose -아요 when the last vowel of the stem is ㅏ or ㅗ. Choose -어요 for all other vowels. 하다 verbs become 해요.',
    formationRules: [
      'Last vowel ㅏ or ㅗ → -아요: 가다 → 가요, 오다 → 와요',
      'All other vowels → -어요: 먹다 → 먹어요, 읽다 → 읽어요',
      '하다 → 해요: 공부하다 → 공부해요, 운동하다 → 운동해요',
      'Contraction: 오 + 아 → 와, 마시 + 어 → 마셔, 배우 + 어 → 배워',
    ],
    examples: [
      { korean: '학교에 가요.', english: 'I go to school.', highlight: '가요' },
      { korean: '밥을 먹어요.', english: 'I eat rice.', highlight: '먹어요' },
      { korean: '한국어를 공부해요.', english: 'I study Korean.', highlight: '공부해요' },
      { korean: '음악을 들어요.', english: 'I listen to music.', highlight: '들어요' },
      { korean: '커피를 마셔요.', english: 'I drink coffee.', highlight: '마셔요' },
      { korean: '친구를 만나요.', english: 'I meet a friend.', highlight: '만나요' },
    ],
    practice: [
      { prompt: 'I go. → 가다 → _____.', answer: '가요', hint: '가 has vowel ㅏ → 가 + 아요 → 가요' },
      { prompt: 'I eat. → 먹다 → _____.', answer: '먹어요', hint: '먹 has vowel ㅓ → 먹 + 어요 → 먹어요' },
      { prompt: 'I study. → 공부하다 → _____.', answer: '공부해요', hint: '하다 always becomes 해요' },
      { prompt: 'I drink. → 마시다 → _____.', answer: '마셔요', hint: '마시 + 어요 contracts to 마셔요' },
    ],
    quiz: [
      { id: 'g4-01-q1', question: 'Conjugate 읽다 (to read) to present tense.', options: ['읽아요', '읽어요', '읽해요', '읽여요'], correctIndex: 1, explanation: '읽 has vowel ㅣ (not ㅏ/ㅗ) → 읽 + 어요 → 읽어요' },
      { id: 'g4-01-q2', question: 'Conjugate 오다 (to come) to present tense.', options: ['오아요', '오어요', '와요', '오해요'], correctIndex: 2, explanation: '오 + 아요 contracts to 와요' },
      { id: 'g4-01-q3', question: 'Which rule applies to 하다 verbs?', options: ['Add -아요', 'Add -어요', 'Change to 해요', 'Add -여요'], correctIndex: 2, explanation: '하다 always becomes 해요. This is a special rule.' },
    ],
  },
  {
    id: 'g4-02',
    unitId: 'unit-4',
    title: 'Negation: 안',
    titleKorean: '안 부정문',
    pattern: '안 + Verb/Adjective',
    level: 'beginner',
    explanation: 'The simplest way to negate in Korean is to place "안" before the verb or adjective. For 하다 compound verbs, 안 goes between the noun and 하다: 공부 안 해요 (not 안 공부해요).',
    formationRules: [
      'Basic: 안 + verb → 안 가요 (I don\'t go)',
      'With adjectives: 안 + adj → 안 좋아요 (It\'s not good)',
      '하다 verbs: Noun + 안 + 하다 → 공부 안 해요 (I don\'t study)',
      'Exception: 있다/없다 does NOT use 안. Use 없다 instead.',
    ],
    examples: [
      { korean: '오늘 학교에 안 가요.', english: 'I don\'t go to school today.', highlight: '안' },
      { korean: '커피를 안 마셔요.', english: 'I don\'t drink coffee.', highlight: '안' },
      { korean: '공부 안 해요.', english: 'I don\'t study.', highlight: '안' },
      { korean: '날씨가 안 좋아요.', english: 'The weather is not good.', highlight: '안' },
    ],
    practice: [
      { prompt: 'I don\'t eat. → 밥을 ___ 먹어요.', answer: '안', hint: 'Place 안 before the verb' },
      { prompt: 'I don\'t study. → 공부 ___ 해요.', answer: '안', hint: 'For 하다 verbs, 안 goes between noun and 하다' },
    ],
    quiz: [
      { id: 'g4-02-q1', question: 'How do you say "I don\'t study"?', options: ['안 공부해요', '공부 안 해요', '공부해 안요', '공부 않아요'], correctIndex: 1, explanation: 'For 하다 compounds: Noun + 안 + 하다 → 공부 안 해요' },
      { id: 'g4-02-q2', question: 'Which is INCORRECT?', options: ['안 가요', '안 먹어요', '안 있어요', '안 좋아요'], correctIndex: 2, explanation: '있다 cannot be negated with 안. Use 없다 instead.' },
    ],
  },

  // ===== UNIT 5: Family & People =====
  {
    id: 'g5-01',
    unitId: 'unit-5',
    title: 'Honorific: -(으)세요',
    titleKorean: '-(으)세요',
    pattern: 'Verb stem + -(으)세요',
    level: 'beginner',
    explanation: 'Use -(으)세요 to show respect when talking about someone older or higher in status. It replaces the regular -아/어요 ending. It can also be used for polite requests ("Please do..."). Use -세요 after vowels and -으세요 after consonants.',
    formationRules: [
      'After vowel: -세요 → 가다 → 가세요 (He/she goes [honorific])',
      'After consonant: -으세요 → 읽다 → 읽으세요 (Please read)',
      'Special: 먹다 → 드시다 → 드세요 (eats, honorific)',
      'Special: 있다 → 계시다 → 계세요 (exists/is at, honorific)',
      'Special: 자다 → 주무시다 → 주무세요 (sleeps, honorific)',
    ],
    examples: [
      { korean: '어머니가 요리하세요.', english: 'Mother cooks. (honorific)', highlight: '하세요' },
      { korean: '선생님이 책을 읽으세요.', english: 'The teacher reads a book. (honorific)', highlight: '읽으세요' },
      { korean: '할아버지가 서울에 계세요.', english: 'Grandfather is in Seoul. (honorific)', highlight: '계세요' },
      { korean: '여기에 앉으세요.', english: 'Please sit here.', highlight: '앉으세요' },
      { korean: '안녕히 가세요.', english: 'Goodbye. (to person leaving)', highlight: '가세요' },
    ],
    practice: [
      { prompt: 'Father goes to work. (honorific) → 아버지가 회사에 _____.', answer: '가세요', hint: '가다 stem ends in vowel → 가세요' },
      { prompt: 'Please read this. → 이것을 _____.', answer: '읽으세요', hint: '읽다 stem ends in consonant → 읽으세요' },
      { prompt: 'Grandmother eats. (honorific) → 할머니가 _____.', answer: '드세요', hint: '먹다 honorific = 드시다 → 드세요' },
    ],
    quiz: [
      { id: 'g5-01-q1', question: 'What is the honorific form of 먹다?', options: ['먹으세요', '먹세요', '드세요', '먹이세요'], correctIndex: 2, explanation: '먹다 has a special honorific form: 드시다 → 드세요' },
      { id: 'g5-01-q2', question: 'When do you use -(으)세요?', options: ['With friends', 'With younger people', 'With elders/superiors or for polite requests', 'Only in writing'], correctIndex: 2, explanation: '-(으)세요 shows respect for elders/superiors and makes polite requests.' },
    ],
  },

  // ===== UNIT 6: Food & Dining =====
  {
    id: 'g6-01',
    unitId: 'unit-6',
    title: 'Wanting: -고 싶다',
    titleKorean: '-고 싶다',
    pattern: 'Verb stem + -고 싶다',
    level: 'beginner',
    explanation: 'Attach -고 싶다 to a verb stem to say "I want to (do something)." For talking about what someone else wants, use -고 싶어하다 instead. The negative is -고 싶지 않다 (don\'t want to).',
    formationRules: [
      'I want to: Verb stem + -고 싶어요 → 먹고 싶어요 (I want to eat)',
      'I don\'t want to: Verb stem + -고 싶지 않아요',
      'Third person: Verb stem + -고 싶어해요 → 가고 싶어해요 (They want to go)',
      'Question: Verb stem + -고 싶어요? → 뭐 먹고 싶어요? (What do you want to eat?)',
    ],
    examples: [
      { korean: '한국에 가고 싶어요.', english: 'I want to go to Korea.', highlight: '-고 싶어요' },
      { korean: '비빔밥을 먹고 싶어요.', english: 'I want to eat bibimbap.', highlight: '먹고 싶어요' },
      { korean: '뭐 마시고 싶어요?', english: 'What do you want to drink?', highlight: '마시고 싶어요' },
      { korean: '자고 싶지 않아요.', english: 'I don\'t want to sleep.', highlight: '싶지 않아요' },
      { korean: '친구가 영화를 보고 싶어해요.', english: 'My friend wants to watch a movie.', highlight: '싶어해요' },
    ],
    practice: [
      { prompt: 'I want to eat. → 먹___ _____.', answer: '고 싶어요', hint: 'Verb stem + 고 싶어요' },
      { prompt: 'I want to go to Korea. → 한국에 가___ _____.', answer: '고 싶어요', hint: 'Attach -고 싶어요 to 가' },
      { prompt: 'I don\'t want to study. → 공부하고 _____ _____.', answer: '싶지 않아요', hint: 'Negative: 싶지 않아요' },
    ],
    quiz: [
      { id: 'g6-01-q1', question: 'How do you say "I want to eat Korean food"?', options: ['한국 음식 먹고 싶어요', '한국 음식을 먹고 싶어요', '한국 음식을 먹고 싶다', '한국 음식을 먹고 싶어해요'], correctIndex: 1, explanation: 'Object + 을/를 + verb stem + 고 싶어요. Use 싶어요 for yourself.' },
      { id: 'g6-01-q2', question: 'For a third person (he/she wants to...), use:', options: ['-고 싶어요', '-고 싶다', '-고 싶어해요', '-고 싶지 않아요'], correctIndex: 2, explanation: 'For third person, use -고 싶어하다 instead of -고 싶다.' },
    ],
  },
  {
    id: 'g6-02',
    unitId: 'unit-6',
    title: 'Requesting: 주세요 & Also: 도',
    titleKorean: '주세요, 도',
    pattern: 'Noun + 주세요 | Noun + 도',
    level: 'beginner',
    explanation: '주세요 means "please give me" — essential for ordering food, shopping, and making requests. 도 replaces other particles and means "also/too." It\'s one of the most useful particles in Korean.',
    formationRules: [
      'Please give: Noun + 주세요 → 물 주세요 (Water, please)',
      'Please do: Verb stem + -아/어 주세요 → 도와 주세요 (Please help)',
      'Also/too: Noun + 도 → 저도 (me too), 이것도 (this too)',
      '도 replaces 은/는, 이/가, 을/를 — it doesn\'t stack with them',
    ],
    examples: [
      { korean: '물 주세요.', english: 'Water, please.', highlight: '주세요' },
      { korean: '비빔밥 하나 주세요.', english: 'One bibimbap, please.', highlight: '주세요' },
      { korean: '메뉴 좀 주세요.', english: 'Menu, please. (좀 softens the request)', highlight: '주세요' },
      { korean: '저도 커피 마시고 싶어요.', english: 'I also want to drink coffee.', highlight: '도' },
      { korean: '이것도 주세요.', english: 'Please give me this too.', highlight: '도' },
    ],
    practice: [
      { prompt: 'Coffee, please. → 커피 _____.', answer: '주세요', hint: 'Noun + 주세요 for requests' },
      { prompt: 'I also like it. → 저___ 좋아해요.', answer: '도', hint: '도 means "also/too" and replaces 는' },
      { prompt: 'Please help me. → 도와 _____.', answer: '주세요', hint: 'Verb stem + 아/어 주세요 for "please do"' },
    ],
    quiz: [
      { id: 'g6-02-q1', question: 'How do you order bibimbap?', options: ['비빔밥 있어요', '비빔밥 주세요', '비빔밥 해요', '비빔밥 가세요'], correctIndex: 1, explanation: 'Noun + 주세요 is the standard way to order/request.' },
      { id: 'g6-02-q2', question: '저___ 학생이에요. (I am ALSO a student)', options: ['는', '가', '도', '를'], correctIndex: 2, explanation: '도 means "also" and replaces topic/subject particles.' },
    ],
  },

  // ===== UNIT 8: Time & Schedule =====
  {
    id: 'g8-01',
    unitId: 'unit-8',
    title: 'Past Tense: -았/었어요',
    titleKorean: '과거형 -았/었어요',
    pattern: 'Verb stem + -았어요/었어요',
    level: 'topik1',
    explanation: 'The past tense follows the same vowel harmony rules as present tense. If the last vowel of the stem is ㅏ or ㅗ, use -았어요. For all others, use -었어요. 하다 becomes 했어요.',
    formationRules: [
      'Last vowel ㅏ/ㅗ → -았어요: 가다 → 갔어요, 오다 → 왔어요',
      'Other vowels → -었어요: 먹다 → 먹었어요, 읽다 → 읽었어요',
      '하다 → 했어요: 공부하다 → 공부했어요',
      'Contraction: 가 + 았 → 갔, 오 + 았 → 왔, 마시 + 었 → 마셨',
    ],
    examples: [
      { korean: '어제 학교에 갔어요.', english: 'I went to school yesterday.', highlight: '갔어요' },
      { korean: '밥을 먹었어요.', english: 'I ate rice.', highlight: '먹었어요' },
      { korean: '한국어를 공부했어요.', english: 'I studied Korean.', highlight: '공부했어요' },
      { korean: '친구를 만났어요.', english: 'I met a friend.', highlight: '만났어요' },
      { korean: '영화를 봤어요.', english: 'I watched a movie.', highlight: '봤어요' },
    ],
    practice: [
      { prompt: 'I went. → 가다 → _____.', answer: '갔어요', hint: '가 + 았어요 → 갔어요' },
      { prompt: 'I ate. → 먹다 → _____.', answer: '먹었어요', hint: '먹 (vowel ㅓ) + 었어요 → 먹었어요' },
      { prompt: 'I studied. → 공부하다 → _____.', answer: '공부했어요', hint: '하다 always becomes 했어요 in past tense' },
    ],
    quiz: [
      { id: 'g8-01-q1', question: 'Conjugate 보다 (to see) to past tense.', options: ['보았어요', '봤어요', '보었어요', 'Both A and B'], correctIndex: 3, explanation: '보 + 았어요 = 보았어요, which contracts to 봤어요. Both are correct.' },
      { id: 'g8-01-q2', question: 'Conjugate 마시다 (to drink) to past tense.', options: ['마시았어요', '마셨어요', '마시었어요', 'Both B and C'], correctIndex: 3, explanation: '마시 + 었어요 = 마시었어요, which contracts to 마셨어요. Both correct.' },
    ],
  },
];

/**
 * Get grammar lessons for a specific unit
 */
export function getGrammarByUnit(unitId: string): GrammarLesson[] {
  return grammarLessons.filter((g) => g.unitId === unitId);
}

/**
 * Get a specific grammar lesson by ID
 */
export function getGrammarById(id: string): GrammarLesson | undefined {
  return grammarLessons.find((g) => g.id === id);
}
