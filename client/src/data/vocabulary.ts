/**
 * Vocabulary Data
 * Real Korean vocabulary organized by unit, with example sentences.
 * Each word includes Korean, English, romanization hint, example sentence,
 * and part of speech for study context.
 */

export interface VocabWord {
  id: string;
  korean: string;
  english: string;
  partOfSpeech: 'noun' | 'verb' | 'adjective' | 'adverb' | 'particle' | 'expression';
  exampleKorean: string;
  exampleEnglish: string;
  unitId: string;
  difficulty: number;
}

export const vocabularyData: VocabWord[] = [
  // ===== UNIT 1: Greetings & Introductions =====
  { id: 'v1-01', korean: '안녕하세요', english: 'Hello (polite)', partOfSpeech: 'expression', exampleKorean: '안녕하세요! 저는 제이슨이에요.', exampleEnglish: 'Hello! I am Jason.', unitId: 'unit-1', difficulty: 1 },
  { id: 'v1-02', korean: '감사합니다', english: 'Thank you (formal)', partOfSpeech: 'expression', exampleKorean: '도와주셔서 감사합니다.', exampleEnglish: 'Thank you for helping me.', unitId: 'unit-1', difficulty: 1 },
  { id: 'v1-03', korean: '죄송합니다', english: 'I\'m sorry (formal)', partOfSpeech: 'expression', exampleKorean: '늦어서 죄송합니다.', exampleEnglish: 'I\'m sorry for being late.', unitId: 'unit-1', difficulty: 1 },
  { id: 'v1-04', korean: '네', english: 'Yes', partOfSpeech: 'expression', exampleKorean: '네, 맞아요.', exampleEnglish: 'Yes, that\'s right.', unitId: 'unit-1', difficulty: 1 },
  { id: 'v1-05', korean: '아니요', english: 'No', partOfSpeech: 'expression', exampleKorean: '아니요, 괜찮아요.', exampleEnglish: 'No, it\'s okay.', unitId: 'unit-1', difficulty: 1 },
  { id: 'v1-06', korean: '이름', english: 'Name', partOfSpeech: 'noun', exampleKorean: '이름이 뭐예요?', exampleEnglish: 'What is your name?', unitId: 'unit-1', difficulty: 1 },
  { id: 'v1-07', korean: '저', english: 'I/me (humble)', partOfSpeech: 'noun', exampleKorean: '저는 학생이에요.', exampleEnglish: 'I am a student.', unitId: 'unit-1', difficulty: 1 },
  { id: 'v1-08', korean: '나', english: 'I/me (casual)', partOfSpeech: 'noun', exampleKorean: '나는 한국어를 공부해.', exampleEnglish: 'I study Korean.', unitId: 'unit-1', difficulty: 1 },
  { id: 'v1-09', korean: '사람', english: 'Person/people', partOfSpeech: 'noun', exampleKorean: '그 사람은 선생님이에요.', exampleEnglish: 'That person is a teacher.', unitId: 'unit-1', difficulty: 1 },
  { id: 'v1-10', korean: '나라', english: 'Country', partOfSpeech: 'noun', exampleKorean: '어느 나라에서 왔어요?', exampleEnglish: 'Which country are you from?', unitId: 'unit-1', difficulty: 1 },
  { id: 'v1-11', korean: '한국', english: 'Korea', partOfSpeech: 'noun', exampleKorean: '한국은 아름다운 나라예요.', exampleEnglish: 'Korea is a beautiful country.', unitId: 'unit-1', difficulty: 1 },
  { id: 'v1-12', korean: '미국', english: 'America/USA', partOfSpeech: 'noun', exampleKorean: '저는 미국에서 왔어요.', exampleEnglish: 'I came from America.', unitId: 'unit-1', difficulty: 1 },
  { id: 'v1-13', korean: '학생', english: 'Student', partOfSpeech: 'noun', exampleKorean: '저는 대학생이에요.', exampleEnglish: 'I am a university student.', unitId: 'unit-1', difficulty: 1 },
  { id: 'v1-14', korean: '선생님', english: 'Teacher', partOfSpeech: 'noun', exampleKorean: '선생님, 질문이 있어요.', exampleEnglish: 'Teacher, I have a question.', unitId: 'unit-1', difficulty: 1 },
  { id: 'v1-15', korean: '회사원', english: 'Office worker', partOfSpeech: 'noun', exampleKorean: '아버지는 회사원이에요.', exampleEnglish: 'My father is an office worker.', unitId: 'unit-1', difficulty: 1 },
  { id: 'v1-16', korean: '만나다', english: 'To meet', partOfSpeech: 'verb', exampleKorean: '만나서 반갑습니다.', exampleEnglish: 'Nice to meet you.', unitId: 'unit-1', difficulty: 1 },
  { id: 'v1-17', korean: '반갑다', english: 'To be glad/nice (to meet)', partOfSpeech: 'adjective', exampleKorean: '반갑습니다!', exampleEnglish: 'Nice to meet you!', unitId: 'unit-1', difficulty: 1 },
  { id: 'v1-18', korean: '안녕히 가세요', english: 'Goodbye (to person leaving)', partOfSpeech: 'expression', exampleKorean: '안녕히 가세요! 내일 봐요.', exampleEnglish: 'Goodbye! See you tomorrow.', unitId: 'unit-1', difficulty: 1 },
  { id: 'v1-19', korean: '안녕히 계세요', english: 'Goodbye (to person staying)', partOfSpeech: 'expression', exampleKorean: '안녕히 계세요, 선생님.', exampleEnglish: 'Goodbye, teacher.', unitId: 'unit-1', difficulty: 1 },
  { id: 'v1-20', korean: '어디', english: 'Where', partOfSpeech: 'adverb', exampleKorean: '어디에서 왔어요?', exampleEnglish: 'Where are you from?', unitId: 'unit-1', difficulty: 1 },
  { id: 'v1-21', korean: '뭐', english: 'What', partOfSpeech: 'adverb', exampleKorean: '이름이 뭐예요?', exampleEnglish: 'What is your name?', unitId: 'unit-1', difficulty: 1 },
  { id: 'v1-22', korean: '괜찮다', english: 'To be okay/fine', partOfSpeech: 'adjective', exampleKorean: '괜찮아요, 걱정하지 마세요.', exampleEnglish: 'It\'s okay, don\'t worry.', unitId: 'unit-1', difficulty: 1 },
  { id: 'v1-23', korean: '처음', english: 'First time', partOfSpeech: 'noun', exampleKorean: '처음 뵙겠습니다.', exampleEnglish: 'Nice to meet you (very formal).', unitId: 'unit-1', difficulty: 2 },
  { id: 'v1-24', korean: '한국어', english: 'Korean language', partOfSpeech: 'noun', exampleKorean: '한국어를 공부하고 있어요.', exampleEnglish: 'I am studying Korean.', unitId: 'unit-1', difficulty: 1 },
  { id: 'v1-25', korean: '영어', english: 'English language', partOfSpeech: 'noun', exampleKorean: '영어를 할 수 있어요?', exampleEnglish: 'Can you speak English?', unitId: 'unit-1', difficulty: 1 },

  // ===== UNIT 2: Basic Sentences =====
  { id: 'v2-01', korean: '이것', english: 'This (thing)', partOfSpeech: 'noun', exampleKorean: '이것은 책이에요.', exampleEnglish: 'This is a book.', unitId: 'unit-2', difficulty: 1 },
  { id: 'v2-02', korean: '그것', english: 'That (thing, near listener)', partOfSpeech: 'noun', exampleKorean: '그것은 뭐예요?', exampleEnglish: 'What is that?', unitId: 'unit-2', difficulty: 1 },
  { id: 'v2-03', korean: '저것', english: 'That (thing, far away)', partOfSpeech: 'noun', exampleKorean: '저것은 학교예요.', exampleEnglish: 'That over there is a school.', unitId: 'unit-2', difficulty: 1 },
  { id: 'v2-04', korean: '책', english: 'Book', partOfSpeech: 'noun', exampleKorean: '이 책은 재미있어요.', exampleEnglish: 'This book is fun.', unitId: 'unit-2', difficulty: 1 },
  { id: 'v2-05', korean: '의자', english: 'Chair', partOfSpeech: 'noun', exampleKorean: '의자에 앉으세요.', exampleEnglish: 'Please sit in the chair.', unitId: 'unit-2', difficulty: 1 },
  { id: 'v2-06', korean: '책상', english: 'Desk', partOfSpeech: 'noun', exampleKorean: '책상 위에 책이 있어요.', exampleEnglish: 'There is a book on the desk.', unitId: 'unit-2', difficulty: 1 },
  { id: 'v2-07', korean: '집', english: 'House/home', partOfSpeech: 'noun', exampleKorean: '집에 가고 싶어요.', exampleEnglish: 'I want to go home.', unitId: 'unit-2', difficulty: 1 },
  { id: 'v2-08', korean: '학교', english: 'School', partOfSpeech: 'noun', exampleKorean: '학교에서 공부해요.', exampleEnglish: 'I study at school.', unitId: 'unit-2', difficulty: 1 },
  { id: 'v2-09', korean: '있다', english: 'To exist/to have', partOfSpeech: 'verb', exampleKorean: '시간이 있어요?', exampleEnglish: 'Do you have time?', unitId: 'unit-2', difficulty: 1 },
  { id: 'v2-10', korean: '없다', english: 'To not exist/to not have', partOfSpeech: 'verb', exampleKorean: '돈이 없어요.', exampleEnglish: 'I don\'t have money.', unitId: 'unit-2', difficulty: 1 },
  { id: 'v2-11', korean: '위', english: 'Above/on top', partOfSpeech: 'noun', exampleKorean: '책상 위에 컵이 있어요.', exampleEnglish: 'There is a cup on the desk.', unitId: 'unit-2', difficulty: 1 },
  { id: 'v2-12', korean: '아래', english: 'Below/under', partOfSpeech: 'noun', exampleKorean: '의자 아래에 가방이 있어요.', exampleEnglish: 'There is a bag under the chair.', unitId: 'unit-2', difficulty: 1 },
  { id: 'v2-13', korean: '옆', english: 'Next to/beside', partOfSpeech: 'noun', exampleKorean: '학교 옆에 도서관이 있어요.', exampleEnglish: 'There is a library next to the school.', unitId: 'unit-2', difficulty: 1 },
  { id: 'v2-14', korean: '안', english: 'Inside', partOfSpeech: 'noun', exampleKorean: '가방 안에 뭐가 있어요?', exampleEnglish: 'What is inside the bag?', unitId: 'unit-2', difficulty: 1 },
  { id: 'v2-15', korean: '밖', english: 'Outside', partOfSpeech: 'noun', exampleKorean: '밖에 비가 와요.', exampleEnglish: 'It\'s raining outside.', unitId: 'unit-2', difficulty: 1 },
  { id: 'v2-16', korean: '앞', english: 'Front/in front of', partOfSpeech: 'noun', exampleKorean: '학교 앞에서 만나요.', exampleEnglish: 'Let\'s meet in front of the school.', unitId: 'unit-2', difficulty: 1 },
  { id: 'v2-17', korean: '뒤', english: 'Behind/back', partOfSpeech: 'noun', exampleKorean: '건물 뒤에 주차장이 있어요.', exampleEnglish: 'There is a parking lot behind the building.', unitId: 'unit-2', difficulty: 1 },
  { id: 'v2-18', korean: '가방', english: 'Bag', partOfSpeech: 'noun', exampleKorean: '가방이 무거워요.', exampleEnglish: 'The bag is heavy.', unitId: 'unit-2', difficulty: 1 },
  { id: 'v2-19', korean: '전화', english: 'Phone/phone call', partOfSpeech: 'noun', exampleKorean: '전화번호가 뭐예요?', exampleEnglish: 'What is your phone number?', unitId: 'unit-2', difficulty: 1 },
  { id: 'v2-20', korean: '물', english: 'Water', partOfSpeech: 'noun', exampleKorean: '물 주세요.', exampleEnglish: 'Water, please.', unitId: 'unit-2', difficulty: 1 },
  { id: 'v2-21', korean: '컴퓨터', english: 'Computer', partOfSpeech: 'noun', exampleKorean: '컴퓨터가 느려요.', exampleEnglish: 'The computer is slow.', unitId: 'unit-2', difficulty: 1 },
  { id: 'v2-22', korean: '핸드폰', english: 'Cell phone', partOfSpeech: 'noun', exampleKorean: '핸드폰이 어디에 있어요?', exampleEnglish: 'Where is the cell phone?', unitId: 'unit-2', difficulty: 1 },
  { id: 'v2-23', korean: '크다', english: 'To be big', partOfSpeech: 'adjective', exampleKorean: '이 방은 커요.', exampleEnglish: 'This room is big.', unitId: 'unit-2', difficulty: 1 },
  { id: 'v2-24', korean: '작다', english: 'To be small', partOfSpeech: 'adjective', exampleKorean: '그 가방은 작아요.', exampleEnglish: 'That bag is small.', unitId: 'unit-2', difficulty: 1 },
  { id: 'v2-25', korean: '많다', english: 'To be many/much', partOfSpeech: 'adjective', exampleKorean: '사람이 많아요.', exampleEnglish: 'There are many people.', unitId: 'unit-2', difficulty: 1 },
  { id: 'v2-26', korean: '적다', english: 'To be few/little', partOfSpeech: 'adjective', exampleKorean: '시간이 적어요.', exampleEnglish: 'There is little time.', unitId: 'unit-2', difficulty: 1 },
  { id: 'v2-27', korean: '좋다', english: 'To be good', partOfSpeech: 'adjective', exampleKorean: '날씨가 좋아요.', exampleEnglish: 'The weather is good.', unitId: 'unit-2', difficulty: 1 },
  { id: 'v2-28', korean: '나쁘다', english: 'To be bad', partOfSpeech: 'adjective', exampleKorean: '기분이 나빠요.', exampleEnglish: 'I feel bad / I\'m in a bad mood.', unitId: 'unit-2', difficulty: 1 },
  { id: 'v2-29', korean: '새롭다', english: 'To be new', partOfSpeech: 'adjective', exampleKorean: '새로운 책을 샀어요.', exampleEnglish: 'I bought a new book.', unitId: 'unit-2', difficulty: 2 },
  { id: 'v2-30', korean: '도서관', english: 'Library', partOfSpeech: 'noun', exampleKorean: '도서관에서 책을 읽어요.', exampleEnglish: 'I read books at the library.', unitId: 'unit-2', difficulty: 1 },

  // ===== UNIT 3: Numbers & Counting =====
  { id: 'v3-01', korean: '일', english: 'One (Sino-Korean)', partOfSpeech: 'noun', exampleKorean: '일월은 겨울이에요.', exampleEnglish: 'January is winter.', unitId: 'unit-3', difficulty: 1 },
  { id: 'v3-02', korean: '이', english: 'Two (Sino-Korean)', partOfSpeech: 'noun', exampleKorean: '이번 주에 시험이 있어요.', exampleEnglish: 'There is an exam this week.', unitId: 'unit-3', difficulty: 1 },
  { id: 'v3-03', korean: '삼', english: 'Three (Sino-Korean)', partOfSpeech: 'noun', exampleKorean: '삼월에 봄이 와요.', exampleEnglish: 'Spring comes in March.', unitId: 'unit-3', difficulty: 1 },
  { id: 'v3-04', korean: '사', english: 'Four (Sino-Korean)', partOfSpeech: 'noun', exampleKorean: '사 더하기 오는 구예요.', exampleEnglish: 'Four plus five is nine.', unitId: 'unit-3', difficulty: 1 },
  { id: 'v3-05', korean: '오', english: 'Five (Sino-Korean)', partOfSpeech: 'noun', exampleKorean: '오분 후에 만나요.', exampleEnglish: 'Let\'s meet in five minutes.', unitId: 'unit-3', difficulty: 1 },
  { id: 'v3-06', korean: '하나', english: 'One (Native Korean)', partOfSpeech: 'noun', exampleKorean: '사과 하나 주세요.', exampleEnglish: 'One apple, please.', unitId: 'unit-3', difficulty: 1 },
  { id: 'v3-07', korean: '둘', english: 'Two (Native Korean)', partOfSpeech: 'noun', exampleKorean: '커피 두 잔 주세요.', exampleEnglish: 'Two cups of coffee, please.', unitId: 'unit-3', difficulty: 1 },
  { id: 'v3-08', korean: '셋', english: 'Three (Native Korean)', partOfSpeech: 'noun', exampleKorean: '세 명이 왔어요.', exampleEnglish: 'Three people came.', unitId: 'unit-3', difficulty: 1 },
  { id: 'v3-09', korean: '넷', english: 'Four (Native Korean)', partOfSpeech: 'noun', exampleKorean: '네 시에 만나요.', exampleEnglish: 'Let\'s meet at four o\'clock.', unitId: 'unit-3', difficulty: 1 },
  { id: 'v3-10', korean: '다섯', english: 'Five (Native Korean)', partOfSpeech: 'noun', exampleKorean: '다섯 개 샀어요.', exampleEnglish: 'I bought five (things).', unitId: 'unit-3', difficulty: 1 },
  { id: 'v3-11', korean: '여섯', english: 'Six (Native Korean)', partOfSpeech: 'noun', exampleKorean: '여섯 시에 일어나요.', exampleEnglish: 'I wake up at six o\'clock.', unitId: 'unit-3', difficulty: 1 },
  { id: 'v3-12', korean: '일곱', english: 'Seven (Native Korean)', partOfSpeech: 'noun', exampleKorean: '일곱 시에 저녁을 먹어요.', exampleEnglish: 'I eat dinner at seven o\'clock.', unitId: 'unit-3', difficulty: 1 },
  { id: 'v3-13', korean: '시', english: 'O\'clock/hour', partOfSpeech: 'noun', exampleKorean: '지금 몇 시예요?', exampleEnglish: 'What time is it now?', unitId: 'unit-3', difficulty: 1 },
  { id: 'v3-14', korean: '분', english: 'Minute', partOfSpeech: 'noun', exampleKorean: '십오 분 걸려요.', exampleEnglish: 'It takes fifteen minutes.', unitId: 'unit-3', difficulty: 1 },
  { id: 'v3-15', korean: '원', english: 'Won (Korean currency)', partOfSpeech: 'noun', exampleKorean: '삼천 원이에요.', exampleEnglish: 'It\'s 3,000 won.', unitId: 'unit-3', difficulty: 1 },
  { id: 'v3-16', korean: '개', english: 'Counter for things', partOfSpeech: 'noun', exampleKorean: '사과 세 개 주세요.', exampleEnglish: 'Three apples, please.', unitId: 'unit-3', difficulty: 1 },
  { id: 'v3-17', korean: '명', english: 'Counter for people', partOfSpeech: 'noun', exampleKorean: '다섯 명이 왔어요.', exampleEnglish: 'Five people came.', unitId: 'unit-3', difficulty: 1 },
  { id: 'v3-18', korean: '잔', english: 'Counter for cups/glasses', partOfSpeech: 'noun', exampleKorean: '커피 한 잔 마셨어요.', exampleEnglish: 'I drank one cup of coffee.', unitId: 'unit-3', difficulty: 1 },
  { id: 'v3-19', korean: '권', english: 'Counter for books', partOfSpeech: 'noun', exampleKorean: '책 두 권을 읽었어요.', exampleEnglish: 'I read two books.', unitId: 'unit-3', difficulty: 2 },
  { id: 'v3-20', korean: '번', english: 'Number/time (counter)', partOfSpeech: 'noun', exampleKorean: '전화번호가 뭐예요?', exampleEnglish: 'What is your phone number?', unitId: 'unit-3', difficulty: 1 },
  { id: 'v3-21', korean: '살', english: 'Years old (age counter)', partOfSpeech: 'noun', exampleKorean: '저는 스물다섯 살이에요.', exampleEnglish: 'I am twenty-five years old.', unitId: 'unit-3', difficulty: 1 },
  { id: 'v3-22', korean: '월', english: 'Month', partOfSpeech: 'noun', exampleKorean: '삼월에 한국에 가요.', exampleEnglish: 'I go to Korea in March.', unitId: 'unit-3', difficulty: 1 },
  { id: 'v3-23', korean: '일', english: 'Day (of month)', partOfSpeech: 'noun', exampleKorean: '오늘은 삼월 십구 일이에요.', exampleEnglish: 'Today is March 19th.', unitId: 'unit-3', difficulty: 1 },
  { id: 'v3-24', korean: '얼마', english: 'How much', partOfSpeech: 'adverb', exampleKorean: '이거 얼마예요?', exampleEnglish: 'How much is this?', unitId: 'unit-3', difficulty: 1 },
  { id: 'v3-25', korean: '몇', english: 'How many', partOfSpeech: 'adverb', exampleKorean: '몇 시예요?', exampleEnglish: 'What time is it?', unitId: 'unit-3', difficulty: 1 },

  // ===== UNIT 4: Daily Life =====
  { id: 'v4-01', korean: '일어나다', english: 'To wake up/get up', partOfSpeech: 'verb', exampleKorean: '매일 아침 일곱 시에 일어나요.', exampleEnglish: 'I wake up at 7 every morning.', unitId: 'unit-4', difficulty: 1 },
  { id: 'v4-02', korean: '자다', english: 'To sleep', partOfSpeech: 'verb', exampleKorean: '어젯밤에 늦게 잤어요.', exampleEnglish: 'I slept late last night.', unitId: 'unit-4', difficulty: 1 },
  { id: 'v4-03', korean: '먹다', english: 'To eat', partOfSpeech: 'verb', exampleKorean: '아침을 먹었어요.', exampleEnglish: 'I ate breakfast.', unitId: 'unit-4', difficulty: 1 },
  { id: 'v4-04', korean: '마시다', english: 'To drink', partOfSpeech: 'verb', exampleKorean: '물을 많이 마셔요.', exampleEnglish: 'I drink a lot of water.', unitId: 'unit-4', difficulty: 1 },
  { id: 'v4-05', korean: '가다', english: 'To go', partOfSpeech: 'verb', exampleKorean: '학교에 가요.', exampleEnglish: 'I go to school.', unitId: 'unit-4', difficulty: 1 },
  { id: 'v4-06', korean: '오다', english: 'To come', partOfSpeech: 'verb', exampleKorean: '친구가 집에 왔어요.', exampleEnglish: 'My friend came to my house.', unitId: 'unit-4', difficulty: 1 },
  { id: 'v4-07', korean: '하다', english: 'To do', partOfSpeech: 'verb', exampleKorean: '숙제를 해요.', exampleEnglish: 'I do homework.', unitId: 'unit-4', difficulty: 1 },
  { id: 'v4-08', korean: '공부하다', english: 'To study', partOfSpeech: 'verb', exampleKorean: '도서관에서 공부해요.', exampleEnglish: 'I study at the library.', unitId: 'unit-4', difficulty: 1 },
  { id: 'v4-09', korean: '일하다', english: 'To work', partOfSpeech: 'verb', exampleKorean: '회사에서 일해요.', exampleEnglish: 'I work at a company.', unitId: 'unit-4', difficulty: 1 },
  { id: 'v4-10', korean: '읽다', english: 'To read', partOfSpeech: 'verb', exampleKorean: '매일 책을 읽어요.', exampleEnglish: 'I read books every day.', unitId: 'unit-4', difficulty: 1 },
  { id: 'v4-11', korean: '쓰다', english: 'To write', partOfSpeech: 'verb', exampleKorean: '일기를 써요.', exampleEnglish: 'I write a diary.', unitId: 'unit-4', difficulty: 1 },
  { id: 'v4-12', korean: '보다', english: 'To see/watch', partOfSpeech: 'verb', exampleKorean: '텔레비전을 봐요.', exampleEnglish: 'I watch television.', unitId: 'unit-4', difficulty: 1 },
  { id: 'v4-13', korean: '듣다', english: 'To listen/hear', partOfSpeech: 'verb', exampleKorean: '음악을 들어요.', exampleEnglish: 'I listen to music.', unitId: 'unit-4', difficulty: 1 },
  { id: 'v4-14', korean: '말하다', english: 'To speak/say', partOfSpeech: 'verb', exampleKorean: '한국어로 말해 보세요.', exampleEnglish: 'Try speaking in Korean.', unitId: 'unit-4', difficulty: 1 },
  { id: 'v4-15', korean: '운동하다', english: 'To exercise', partOfSpeech: 'verb', exampleKorean: '아침에 운동해요.', exampleEnglish: 'I exercise in the morning.', unitId: 'unit-4', difficulty: 1 },
  { id: 'v4-16', korean: '씻다', english: 'To wash', partOfSpeech: 'verb', exampleKorean: '손을 씻으세요.', exampleEnglish: 'Please wash your hands.', unitId: 'unit-4', difficulty: 2 },
  { id: 'v4-17', korean: '아침', english: 'Morning/breakfast', partOfSpeech: 'noun', exampleKorean: '아침에 빵을 먹어요.', exampleEnglish: 'I eat bread for breakfast.', unitId: 'unit-4', difficulty: 1 },
  { id: 'v4-18', korean: '점심', english: 'Lunch', partOfSpeech: 'noun', exampleKorean: '점심 같이 먹을까요?', exampleEnglish: 'Shall we eat lunch together?', unitId: 'unit-4', difficulty: 1 },
  { id: 'v4-19', korean: '저녁', english: 'Evening/dinner', partOfSpeech: 'noun', exampleKorean: '저녁에 뭐 해요?', exampleEnglish: 'What do you do in the evening?', unitId: 'unit-4', difficulty: 1 },
  { id: 'v4-20', korean: '매일', english: 'Every day', partOfSpeech: 'adverb', exampleKorean: '매일 한국어를 공부해요.', exampleEnglish: 'I study Korean every day.', unitId: 'unit-4', difficulty: 1 },
  { id: 'v4-21', korean: '오늘', english: 'Today', partOfSpeech: 'noun', exampleKorean: '오늘 날씨가 좋아요.', exampleEnglish: 'The weather is good today.', unitId: 'unit-4', difficulty: 1 },
  { id: 'v4-22', korean: '지금', english: 'Now', partOfSpeech: 'adverb', exampleKorean: '지금 뭐 해요?', exampleEnglish: 'What are you doing now?', unitId: 'unit-4', difficulty: 1 },
  { id: 'v4-23', korean: '보통', english: 'Usually', partOfSpeech: 'adverb', exampleKorean: '보통 여덟 시에 일어나요.', exampleEnglish: 'I usually wake up at 8.', unitId: 'unit-4', difficulty: 1 },
  { id: 'v4-24', korean: '그리고', english: 'And/and then', partOfSpeech: 'adverb', exampleKorean: '밥을 먹었어요. 그리고 커피를 마셨어요.', exampleEnglish: 'I ate. And then I drank coffee.', unitId: 'unit-4', difficulty: 1 },
  { id: 'v4-25', korean: '바쁘다', english: 'To be busy', partOfSpeech: 'adjective', exampleKorean: '요즘 너무 바빠요.', exampleEnglish: 'I am very busy these days.', unitId: 'unit-4', difficulty: 1 },

  // ===== UNIT 5: Family & People =====
  { id: 'v5-01', korean: '가족', english: 'Family', partOfSpeech: 'noun', exampleKorean: '가족이 몇 명이에요?', exampleEnglish: 'How many people are in your family?', unitId: 'unit-5', difficulty: 1 },
  { id: 'v5-02', korean: '아버지', english: 'Father (formal)', partOfSpeech: 'noun', exampleKorean: '아버지는 의사예요.', exampleEnglish: 'My father is a doctor.', unitId: 'unit-5', difficulty: 1 },
  { id: 'v5-03', korean: '어머니', english: 'Mother (formal)', partOfSpeech: 'noun', exampleKorean: '어머니는 요리를 잘 하세요.', exampleEnglish: 'My mother cooks well.', unitId: 'unit-5', difficulty: 1 },
  { id: 'v5-04', korean: '아빠', english: 'Dad', partOfSpeech: 'noun', exampleKorean: '아빠, 사랑해요!', exampleEnglish: 'Dad, I love you!', unitId: 'unit-5', difficulty: 1 },
  { id: 'v5-05', korean: '엄마', english: 'Mom', partOfSpeech: 'noun', exampleKorean: '엄마가 전화했어요.', exampleEnglish: 'Mom called.', unitId: 'unit-5', difficulty: 1 },
  { id: 'v5-06', korean: '형', english: 'Older brother (male speaker)', partOfSpeech: 'noun', exampleKorean: '형은 대학생이에요.', exampleEnglish: 'My older brother is a university student.', unitId: 'unit-5', difficulty: 1 },
  { id: 'v5-07', korean: '오빠', english: 'Older brother (female speaker)', partOfSpeech: 'noun', exampleKorean: '오빠가 도와줬어요.', exampleEnglish: 'My older brother helped me.', unitId: 'unit-5', difficulty: 1 },
  { id: 'v5-08', korean: '누나', english: 'Older sister (male speaker)', partOfSpeech: 'noun', exampleKorean: '누나는 서울에 살아요.', exampleEnglish: 'My older sister lives in Seoul.', unitId: 'unit-5', difficulty: 1 },
  { id: 'v5-09', korean: '언니', english: 'Older sister (female speaker)', partOfSpeech: 'noun', exampleKorean: '언니가 결혼했어요.', exampleEnglish: 'My older sister got married.', unitId: 'unit-5', difficulty: 1 },
  { id: 'v5-10', korean: '동생', english: 'Younger sibling', partOfSpeech: 'noun', exampleKorean: '동생은 고등학생이에요.', exampleEnglish: 'My younger sibling is a high school student.', unitId: 'unit-5', difficulty: 1 },
  { id: 'v5-11', korean: '친구', english: 'Friend', partOfSpeech: 'noun', exampleKorean: '친구를 만났어요.', exampleEnglish: 'I met a friend.', unitId: 'unit-5', difficulty: 1 },
  { id: 'v5-12', korean: '남편', english: 'Husband', partOfSpeech: 'noun', exampleKorean: '남편은 회사원이에요.', exampleEnglish: 'My husband is an office worker.', unitId: 'unit-5', difficulty: 1 },
  { id: 'v5-13', korean: '아내', english: 'Wife', partOfSpeech: 'noun', exampleKorean: '아내와 같이 여행했어요.', exampleEnglish: 'I traveled with my wife.', unitId: 'unit-5', difficulty: 1 },
  { id: 'v5-14', korean: '아이', english: 'Child', partOfSpeech: 'noun', exampleKorean: '아이가 세 명 있어요.', exampleEnglish: 'I have three children.', unitId: 'unit-5', difficulty: 1 },
  { id: 'v5-15', korean: '할아버지', english: 'Grandfather', partOfSpeech: 'noun', exampleKorean: '할아버지는 부산에 계세요.', exampleEnglish: 'My grandfather is in Busan.', unitId: 'unit-5', difficulty: 1 },
  { id: 'v5-16', korean: '할머니', english: 'Grandmother', partOfSpeech: 'noun', exampleKorean: '할머니가 김치를 만드세요.', exampleEnglish: 'Grandmother makes kimchi.', unitId: 'unit-5', difficulty: 1 },
  { id: 'v5-17', korean: '살다', english: 'To live', partOfSpeech: 'verb', exampleKorean: '서울에서 살아요.', exampleEnglish: 'I live in Seoul.', unitId: 'unit-5', difficulty: 1 },
  { id: 'v5-18', korean: '사랑하다', english: 'To love', partOfSpeech: 'verb', exampleKorean: '가족을 사랑해요.', exampleEnglish: 'I love my family.', unitId: 'unit-5', difficulty: 1 },
  { id: 'v5-19', korean: '같이', english: 'Together', partOfSpeech: 'adverb', exampleKorean: '같이 가요!', exampleEnglish: 'Let\'s go together!', unitId: 'unit-5', difficulty: 1 },
  { id: 'v5-20', korean: '의사', english: 'Doctor', partOfSpeech: 'noun', exampleKorean: '의사가 되고 싶어요.', exampleEnglish: 'I want to become a doctor.', unitId: 'unit-5', difficulty: 1 },
  { id: 'v5-21', korean: '결혼하다', english: 'To get married', partOfSpeech: 'verb', exampleKorean: '내년에 결혼해요.', exampleEnglish: 'I\'m getting married next year.', unitId: 'unit-5', difficulty: 2 },
  { id: 'v5-22', korean: '부모님', english: 'Parents (honorific)', partOfSpeech: 'noun', exampleKorean: '부모님이 건강하세요.', exampleEnglish: 'My parents are healthy.', unitId: 'unit-5', difficulty: 1 },
  { id: 'v5-23', korean: '남자', english: 'Man/male', partOfSpeech: 'noun', exampleKorean: '그 남자는 키가 커요.', exampleEnglish: 'That man is tall.', unitId: 'unit-5', difficulty: 1 },
  { id: 'v5-24', korean: '여자', english: 'Woman/female', partOfSpeech: 'noun', exampleKorean: '그 여자는 선생님이에요.', exampleEnglish: 'That woman is a teacher.', unitId: 'unit-5', difficulty: 1 },
  { id: 'v5-25', korean: '아들', english: 'Son', partOfSpeech: 'noun', exampleKorean: '아들이 학교에 가요.', exampleEnglish: 'My son goes to school.', unitId: 'unit-5', difficulty: 1 },

  // ===== UNIT 6: Food & Dining =====
  { id: 'v6-01', korean: '밥', english: 'Rice/meal', partOfSpeech: 'noun', exampleKorean: '밥 먹었어요?', exampleEnglish: 'Have you eaten? (Did you eat rice?)', unitId: 'unit-6', difficulty: 1 },
  { id: 'v6-02', korean: '김치', english: 'Kimchi', partOfSpeech: 'noun', exampleKorean: '김치가 매워요.', exampleEnglish: 'The kimchi is spicy.', unitId: 'unit-6', difficulty: 1 },
  { id: 'v6-03', korean: '불고기', english: 'Bulgogi (grilled marinated beef)', partOfSpeech: 'noun', exampleKorean: '불고기를 좋아해요.', exampleEnglish: 'I like bulgogi.', unitId: 'unit-6', difficulty: 1 },
  { id: 'v6-04', korean: '비빔밥', english: 'Bibimbap (mixed rice)', partOfSpeech: 'noun', exampleKorean: '비빔밥 하나 주세요.', exampleEnglish: 'One bibimbap, please.', unitId: 'unit-6', difficulty: 1 },
  { id: 'v6-05', korean: '라면', english: 'Ramen/ramyeon', partOfSpeech: 'noun', exampleKorean: '라면을 끓이고 있어요.', exampleEnglish: 'I\'m cooking ramen.', unitId: 'unit-6', difficulty: 1 },
  { id: 'v6-06', korean: '고기', english: 'Meat', partOfSpeech: 'noun', exampleKorean: '고기를 구워요.', exampleEnglish: 'I grill meat.', unitId: 'unit-6', difficulty: 1 },
  { id: 'v6-07', korean: '생선', english: 'Fish (for eating)', partOfSpeech: 'noun', exampleKorean: '생선을 좋아해요?', exampleEnglish: 'Do you like fish?', unitId: 'unit-6', difficulty: 1 },
  { id: 'v6-08', korean: '야채', english: 'Vegetables', partOfSpeech: 'noun', exampleKorean: '야채를 많이 먹으세요.', exampleEnglish: 'Please eat lots of vegetables.', unitId: 'unit-6', difficulty: 1 },
  { id: 'v6-09', korean: '과일', english: 'Fruit', partOfSpeech: 'noun', exampleKorean: '과일이 맛있어요.', exampleEnglish: 'The fruit is delicious.', unitId: 'unit-6', difficulty: 1 },
  { id: 'v6-10', korean: '커피', english: 'Coffee', partOfSpeech: 'noun', exampleKorean: '커피 한 잔 주세요.', exampleEnglish: 'One coffee, please.', unitId: 'unit-6', difficulty: 1 },
  { id: 'v6-11', korean: '차', english: 'Tea', partOfSpeech: 'noun', exampleKorean: '녹차를 마시고 싶어요.', exampleEnglish: 'I want to drink green tea.', unitId: 'unit-6', difficulty: 1 },
  { id: 'v6-12', korean: '맛있다', english: 'To be delicious', partOfSpeech: 'adjective', exampleKorean: '이 음식은 정말 맛있어요!', exampleEnglish: 'This food is really delicious!', unitId: 'unit-6', difficulty: 1 },
  { id: 'v6-13', korean: '맵다', english: 'To be spicy', partOfSpeech: 'adjective', exampleKorean: '이거 너무 매워요!', exampleEnglish: 'This is too spicy!', unitId: 'unit-6', difficulty: 1 },
  { id: 'v6-14', korean: '달다', english: 'To be sweet', partOfSpeech: 'adjective', exampleKorean: '케이크가 달아요.', exampleEnglish: 'The cake is sweet.', unitId: 'unit-6', difficulty: 1 },
  { id: 'v6-15', korean: '짜다', english: 'To be salty', partOfSpeech: 'adjective', exampleKorean: '국이 좀 짜요.', exampleEnglish: 'The soup is a bit salty.', unitId: 'unit-6', difficulty: 1 },
  { id: 'v6-16', korean: '배고프다', english: 'To be hungry', partOfSpeech: 'adjective', exampleKorean: '배고파요. 밥 먹으러 가요.', exampleEnglish: 'I\'m hungry. Let\'s go eat.', unitId: 'unit-6', difficulty: 1 },
  { id: 'v6-17', korean: '배부르다', english: 'To be full (stomach)', partOfSpeech: 'adjective', exampleKorean: '너무 많이 먹어서 배불러요.', exampleEnglish: 'I ate too much, I\'m full.', unitId: 'unit-6', difficulty: 1 },
  { id: 'v6-18', korean: '좋아하다', english: 'To like', partOfSpeech: 'verb', exampleKorean: '한국 음식을 좋아해요.', exampleEnglish: 'I like Korean food.', unitId: 'unit-6', difficulty: 1 },
  { id: 'v6-19', korean: '싫어하다', english: 'To dislike', partOfSpeech: 'verb', exampleKorean: '매운 음식을 싫어해요.', exampleEnglish: 'I dislike spicy food.', unitId: 'unit-6', difficulty: 1 },
  { id: 'v6-20', korean: '요리하다', english: 'To cook', partOfSpeech: 'verb', exampleKorean: '주말에 요리해요.', exampleEnglish: 'I cook on weekends.', unitId: 'unit-6', difficulty: 1 },
  { id: 'v6-21', korean: '주문하다', english: 'To order', partOfSpeech: 'verb', exampleKorean: '주문하시겠어요?', exampleEnglish: 'Would you like to order?', unitId: 'unit-6', difficulty: 2 },
  { id: 'v6-22', korean: '식당', english: 'Restaurant', partOfSpeech: 'noun', exampleKorean: '그 식당은 맛있어요.', exampleEnglish: 'That restaurant is delicious.', unitId: 'unit-6', difficulty: 1 },
  { id: 'v6-23', korean: '메뉴', english: 'Menu', partOfSpeech: 'noun', exampleKorean: '메뉴 좀 주세요.', exampleEnglish: 'Please give me the menu.', unitId: 'unit-6', difficulty: 1 },
  { id: 'v6-24', korean: '계산', english: 'Bill/check', partOfSpeech: 'noun', exampleKorean: '계산해 주세요.', exampleEnglish: 'Check, please.', unitId: 'unit-6', difficulty: 1 },
  { id: 'v6-25', korean: '맛없다', english: 'To be not delicious', partOfSpeech: 'adjective', exampleKorean: '이 음식은 맛없어요.', exampleEnglish: 'This food doesn\'t taste good.', unitId: 'unit-6', difficulty: 1 },
  { id: 'v6-26', korean: '빵', english: 'Bread', partOfSpeech: 'noun', exampleKorean: '아침에 빵을 먹어요.', exampleEnglish: 'I eat bread in the morning.', unitId: 'unit-6', difficulty: 1 },
  { id: 'v6-27', korean: '국', english: 'Soup', partOfSpeech: 'noun', exampleKorean: '된장국을 좋아해요.', exampleEnglish: 'I like doenjang soup.', unitId: 'unit-6', difficulty: 1 },
  { id: 'v6-28', korean: '사과', english: 'Apple', partOfSpeech: 'noun', exampleKorean: '사과 두 개 주세요.', exampleEnglish: 'Two apples, please.', unitId: 'unit-6', difficulty: 1 },
  { id: 'v6-29', korean: '우유', english: 'Milk', partOfSpeech: 'noun', exampleKorean: '우유를 매일 마셔요.', exampleEnglish: 'I drink milk every day.', unitId: 'unit-6', difficulty: 1 },
  { id: 'v6-30', korean: '맥주', english: 'Beer', partOfSpeech: 'noun', exampleKorean: '맥주 한 잔 마실까요?', exampleEnglish: 'Shall we have a beer?', unitId: 'unit-6', difficulty: 1 },
];

/**
 * Get vocabulary for a specific unit
 */
export function getVocabByUnit(unitId: string): VocabWord[] {
  return vocabularyData.filter((v) => v.unitId === unitId);
}

/**
 * Get all vocabulary up to and including a given unit number
 */
export function getVocabUpToUnit(unitNumber: number): VocabWord[] {
  return vocabularyData.filter((v) => {
    const num = parseInt(v.unitId.replace('unit-', ''));
    return num <= unitNumber;
  });
}
