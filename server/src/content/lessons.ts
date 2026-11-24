/**
 * Authored lesson content (Milestone 2 seed).
 *
 * Content, not code: this file is the curriculum. It is seeded into the database
 * by `npm run seed` and is the only place lesson text exists, so a content edit is
 * a data migration rather than a code change.
 *
 * Authoring rules applied throughout, from build (1).md §4.3–§4.5:
 *  - Arabic explanations are Saudi colloquial, short, and conversational — the
 *    thing that differentiates this product. No formal MSA lecturing.
 *  - English phrases are the ones a beginner actually says, not textbook English.
 *  - Every speaking prompt has a model answer, accepted variants, required
 *    keywords for intent matching, and *authored* correction hints. Evaluation
 *    never invents a correction (R1), so a prompt without a hint simply produces
 *    no correction instead of a guess.
 *  - Lessons are 3–7 minutes: 3–5 steps, one comprehension question, one prompt.
 *  - No pronunciation scoring anywhere: transcript matching is not phonetics.
 */
import type { Lesson, LessonContent, SpeakingPrompt } from '../domain/models.ts';

interface LessonSeed {
  slug: string;
  title: string;
  titleAr: string;
  description: string;
  topic: string;
  /** Inside a lesson, the Arabic explanation of the situation. */
  situationAr: string;
  phrase: string;
  phraseAr: string;
  /** Optional second phrase for lessons that need a reply pair. */
  phrase2?: { english: string; arabic: string };
  comprehension: { questionAr: string; options: string[]; answerIndex: number };
  prompt: {
    slug: string;
    taskAr: string;
    taskEn: string;
    modelAnswer: string;
    acceptedAnswers: string[];
    requiredKeywords: string[];
    hints?: SpeakingPrompt['correctionHints'];
  };
  vocabulary: { englishTerm: string; arabicMeaning: string; exampleSentence: string }[];
  /** CEFR-ish placement for the starter path. */
  level: Lesson['level'];
}

function build(seed: LessonSeed, index: number): Lesson {
  const hintId = `${seed.slug}_hint`;

  const speakingPrompt: SpeakingPrompt = {
    ...seed.prompt,
    id: hintId,
    languageMode: 'english_only',
    correctionHints: seed.prompt.hints ?? [],
  };

  const content: LessonContent = {
    steps: [
      { id: 'intro', kind: 'intro', explanationAr: seed.situationAr },
      {
        id: 'phrase',
        kind: 'phrase',
        english: seed.phrase,
        arabicMeaning: seed.phraseAr,
        audio: { englishPhrase: seed.phrase, arabicExplanation: seed.situationAr },
      },
      ...(seed.phrase2
        ? [
            {
              id: 'phrase_reply',
              kind: 'phrase' as const,
              english: seed.phrase2.english,
              arabicMeaning: seed.phrase2.arabic,
              audio: { englishPhrase: seed.phrase2.english },
            },
          ]
        : []),
      { id: 'listen', kind: 'listen', english: seed.phrase, audio: { englishPhrase: seed.phrase } },
      { id: 'practise', kind: 'practise', english: seed.prompt.modelAnswer, explanationAr: seed.prompt.taskAr },
      { id: 'review', kind: 'review', explanationAr: 'احفظ الكلمات الجديدة، وتدرّب عليها بكرة مرة ثانية.' },
    ],
    comprehension: [
      {
        prompt: seed.phrase,
        questionAr: seed.comprehension.questionAr,
        options: seed.comprehension.options,
        answerIndex: seed.comprehension.answerIndex,
      },
    ],
    speakingPrompts: [speakingPrompt],
    vocabulary: seed.vocabulary,
  };

  return {
    // Stable, deterministic id so reseeding is idempotent across environments.
    id: `00000000-0000-4000-9000-${String(index + 1).padStart(12, '0')}`,
    slug: seed.slug,
    title: seed.title,
    titleAr: seed.titleAr,
    description: seed.description,
    level: seed.level,
    topic: seed.topic,
    durationMinutes: 4,
    evaluationMode: 'deterministic',
    content,
    published: true,
    createdAt: '2026-11-01T00:00:00.000Z',
  };
}

const SEEDS: LessonSeed[] = [
  {
    slug: 'coffee_order',
    title: 'Ordering coffee',
    titleAr: 'طلب قهوة',
    description: 'Order a coffee politely at a café.',
    topic: 'everyday',
    situationAr: 'إذا دخلت مقهى وتبغى تطلب قهوة، تقدر تقول الجملة هذي بكل أدب.',
    phrase: "I'd like a coffee, please.",
    phraseAr: 'أبغى قهوة، لو سمحت.',
    phrase2: { english: 'Anything else? No, thank you.', arabic: 'شي ثاني؟ لا، شكراً.' },
    comprehension: {
      questionAr: 'وش يعني "I\'d like"؟',
      options: ['أبغى', 'ما أبغى', 'شكراً'],
      answerIndex: 0,
    },
    prompt: {
      slug: 'coffee_order_01',
      taskAr: 'اطلب قهوة بأدب.',
      taskEn: 'Order a coffee politely.',
      modelAnswer: "I'd like a coffee, please.",
      acceptedAnswers: ['I would like a coffee please', 'Can I have a coffee please', 'Id like a coffee please', 'I want a coffee please'],
      requiredKeywords: ['coffee'],
      hints: [
        {
          match: 'i want',
          suggested: "I'd like",
          type: 'style',
          explanationAr: '"I want" مفهومة، لكن "I\'d like" ألطف وأكثر استخداماً في المطاعم والمقاهي.',
        },
        {
          match: 'give me',
          suggested: "Could I have",
          type: 'style',
          explanationAr: '"Give me" تطلع مباشرة شوي. "Could I have" أأدب في الطلب.',
        },
      ],
    },
    vocabulary: [
      { englishTerm: 'coffee', arabicMeaning: 'قهوة', exampleSentence: "I'd like a coffee, please." },
      { englishTerm: 'please', arabicMeaning: 'لو سمحت', exampleSentence: 'A coffee, please.' },
      { englishTerm: 'thank you', arabicMeaning: 'شكراً', exampleSentence: 'Thank you very much.' },
    ],
    level: 'complete_beginner',
  },
  {
    slug: 'introduce_yourself',
    title: 'Introducing yourself',
    titleAr: 'التعريف بنفسك',
    description: 'Say your name and where you are from.',
    topic: 'everyday',
    situationAr: 'أول ما تقابل شخص جديد، تبدأ بالتعريف بنفسك. الجملة سهلة وما تحتاج تفكير.',
    phrase: 'My name is Fahad. Nice to meet you.',
    phraseAr: 'اسمي فهد. تشرفت بمعرفتك.',
    phrase2: { english: "I'm from Riyadh.", arabic: 'أنا من الرياض.' },
    comprehension: {
      questionAr: 'وش تقول بعد ما تعرّف بنفسك؟',
      options: ['Nice to meet you', 'Goodbye', 'How much'],
      answerIndex: 0,
    },
    prompt: {
      slug: 'introduce_yourself_01',
      taskAr: 'عرّف بنفسك بجملة كاملة.',
      taskEn: 'Introduce yourself.',
      modelAnswer: 'My name is Fahad. Nice to meet you.',
      acceptedAnswers: ['My name is Fahad', 'I am Fahad nice to meet you', 'Im Fahad nice to meet you', 'Hello my name is Fahad'],
      requiredKeywords: ['name'],
      hints: [
        {
          match: 'my name fahad',
          suggested: 'My name is Fahad',
          type: 'missing_word',
          explanationAr: 'ناقص فعل "is". الصح: "My name is Fahad".',
        },
      ],
    },
    vocabulary: [
      { englishTerm: 'name', arabicMeaning: 'اسم', exampleSentence: 'My name is Fahad.' },
      { englishTerm: 'from', arabicMeaning: 'من', exampleSentence: "I'm from Riyadh." },
      { englishTerm: 'nice to meet you', arabicMeaning: 'تشرفت بمعرفتك', exampleSentence: 'Nice to meet you, Sarah.' },
    ],
    level: 'complete_beginner',
  },
  {
    slug: 'ordering_food',
    title: 'Ordering food',
    titleAr: 'طلب أكل',
    description: 'Order a meal and ask for the bill.',
    topic: 'everyday',
    situationAr: 'في المطعم، تقدر تطلب الأكل وتطلب الحساب بجملتين بسيطتين.',
    phrase: "Could I have the chicken, please?",
    phraseAr: 'أقدر آخذ الدجاج، لو سمحت؟',
    phrase2: { english: 'Could I have the bill, please?', arabic: 'أقدر آخذ الحساب، لو سمحت؟' },
    comprehension: {
      questionAr: 'كيف تطلب الحساب؟',
      options: ['Could I have the bill, please?', 'Where is the airport?', 'I am fine'],
      answerIndex: 0,
    },
    prompt: {
      slug: 'ordering_food_01',
      taskAr: 'اطلب طبق من المطعم.',
      taskEn: 'Order a dish.',
      modelAnswer: 'Could I have the chicken, please?',
      acceptedAnswers: ['I would like the chicken please', 'Id like the chicken please', 'Can I have the chicken please'],
      requiredKeywords: ['chicken'],
      hints: [
        {
          match: 'i want chicken',
          suggested: 'Could I have the chicken, please?',
          type: 'style',
          explanationAr: 'استخدم "Could I have" — أأدب وأكثر طبيعية في المطعم.',
        },
      ],
    },
    vocabulary: [
      { englishTerm: 'the bill', arabicMeaning: 'الحساب', exampleSentence: 'Could I have the bill, please?' },
      { englishTerm: 'chicken', arabicMeaning: 'دجاج', exampleSentence: 'The chicken is very good.' },
      { englishTerm: 'menu', arabicMeaning: 'قائمة الطعام', exampleSentence: 'Could I see the menu?' },
    ],
    level: 'few_words',
  },
  {
    slug: 'shopping_price',
    title: 'Shopping and asking the price',
    titleAr: 'التسوق والسؤال عن السعر',
    description: 'Ask how much something costs and pay.',
    topic: 'everyday',
    situationAr: 'في المحل، تبغى تعرف السعر وتدفع. جملتين وتخلص.',
    phrase: 'How much is this?',
    phraseAr: 'بكم هذا؟',
    phrase2: { english: 'Can I pay by card?', arabic: 'أقدر أدفع بالبطاقة؟' },
    comprehension: {
      questionAr: 'كيف تسأل عن السعر؟',
      options: ['How much is this?', 'How are you?', 'Where is it?'],
      answerIndex: 0,
    },
    prompt: {
      slug: 'shopping_price_01',
      taskAr: 'اسأل عن سعر شي تبغى تشتريه.',
      taskEn: 'Ask how much something costs.',
      modelAnswer: 'How much is this?',
      acceptedAnswers: ['How much does this cost', 'How much is it', 'What is the price of this'],
      requiredKeywords: ['how much'],
      hints: [
        {
          match: 'how many',
          suggested: 'How much',
          type: 'grammar',
          explanationAr: '"How much" للسعر، و"How many" للعدد. هنا تبغى السعر.',
        },
      ],
    },
    vocabulary: [
      { englishTerm: 'how much', arabicMeaning: 'بكم', exampleSentence: 'How much is this shirt?' },
      { englishTerm: 'card', arabicMeaning: 'بطاقة', exampleSentence: 'Can I pay by card?' },
      { englishTerm: 'cash', arabicMeaning: 'كاش', exampleSentence: 'I will pay in cash.' },
    ],
    level: 'few_words',
  },
  {
    slug: 'asking_directions',
    title: 'Asking for directions',
    titleAr: 'السؤال عن الطريق',
    description: 'Ask where a place is and understand the answer.',
    topic: 'travel',
    situationAr: 'إذا ضيعت، اسأل عن الطريق. الجملة تبدأ بـ"Excuse me" عشان تكون مؤدب.',
    phrase: 'Excuse me, where is the metro station?',
    phraseAr: 'لو سمحت، وين محطة المترو؟',
    phrase2: { english: 'Is it far from here?', arabic: 'بعيدة من هنا؟' },
    comprehension: {
      questionAr: 'كيف تبدأ السؤال عن الطريق بأدب؟',
      options: ['Excuse me', 'Give me', 'No'],
      answerIndex: 0,
    },
    prompt: {
      slug: 'asking_directions_01',
      taskAr: 'اسأل عن مكان قريب منك.',
      taskEn: 'Ask where a place is.',
      modelAnswer: 'Excuse me, where is the metro station?',
      acceptedAnswers: ['Where is the metro station', 'Excuse me where is the station', 'Can you tell me where the station is'],
      requiredKeywords: ['where'],
      hints: [
        {
          match: 'where the station',
          suggested: 'where is the station',
          type: 'missing_word',
          explanationAr: 'ناقص "is". الصح: "where is the station".',
        },
      ],
    },
    vocabulary: [
      { englishTerm: 'where', arabicMeaning: 'وين', exampleSentence: 'Where is the hotel?' },
      { englishTerm: 'near', arabicMeaning: 'قريب', exampleSentence: 'Is it near here?' },
      { englishTerm: 'far', arabicMeaning: 'بعيد', exampleSentence: 'It is not far.' },
    ],
    level: 'simple_understanding',
  },
  {
    slug: 'airport_hotel',
    title: 'Airport and hotel basics',
    titleAr: 'المطار والفندق',
    description: 'Check in at a hotel and ask about your room.',
    topic: 'travel',
    situationAr: 'وصلت الفندق وتبغى تسجّل دخول. تمرّن على الجملة هذي قبل السفر.',
    phrase: "I have a reservation. My name is Fahad.",
    phraseAr: 'عندي حجز. اسمي فهد.',
    phrase2: { english: 'What time is check-out?', arabic: 'الساعة كم تسجيل الخروج؟' },
    comprehension: {
      questionAr: 'وش تقول لما يكون عندك حجز؟',
      options: ['I have a reservation', 'I have a problem', 'I need a taxi'],
      answerIndex: 0,
    },
    prompt: {
      slug: 'airport_hotel_01',
      taskAr: 'قل إن عندك حجز واذكر اسمك.',
      taskEn: 'Say you have a reservation.',
      modelAnswer: 'I have a reservation. My name is Fahad.',
      acceptedAnswers: ['I have a reservation', 'I have a booking my name is Fahad', 'I booked a room my name is Fahad'],
      requiredKeywords: ['reservation'],
      hints: [
        {
          match: 'i have reservation',
          suggested: 'I have a reservation',
          type: 'missing_word',
          explanationAr: 'ناقص "a" قبل reservation.',
        },
      ],
    },
    vocabulary: [
      { englishTerm: 'reservation', arabicMeaning: 'حجز', exampleSentence: 'I have a reservation.' },
      { englishTerm: 'check-out', arabicMeaning: 'تسجيل الخروج', exampleSentence: 'What time is check-out?' },
      { englishTerm: 'room', arabicMeaning: 'غرفة', exampleSentence: 'My room is on the third floor.' },
    ],
    level: 'simple_understanding',
  },
  {
    slug: 'talking_about_your_day',
    title: 'Talking about your day',
    titleAr: 'الكلام عن يومك',
    description: 'Say what you did today and how you feel.',
    topic: 'everyday',
    situationAr: 'لما أحد يسألك عن يومك، تقدر تجاوب بجملة بسيطة بالزمن الماضي.',
    phrase: 'I worked all day and now I am tired.',
    phraseAr: 'اشتغلت طول اليوم والحين أنا تعبان.',
    phrase2: { english: 'How was your day?', arabic: 'كيف كان يومك؟' },
    comprehension: {
      questionAr: 'وش معنى "tired"؟',
      options: ['تعبان', 'جوعان', 'مبسوط'],
      answerIndex: 0,
    },
    prompt: {
      slug: 'talking_about_your_day_01',
      taskAr: 'تكلم عن يومك بجملة أو جملتين.',
      taskEn: 'Talk about your day.',
      modelAnswer: 'I worked all day and now I am tired.',
      acceptedAnswers: ['I worked all day and I am tired', 'I worked today and I am tired', 'I was busy today and I am tired'],
      requiredKeywords: ['tired'],
      hints: [
        {
          match: 'i am work',
          suggested: 'I worked',
          type: 'grammar',
          explanationAr: 'لليوم اللي خلص نستخدم الماضي: "I worked".',
        },
      ],
    },
    vocabulary: [
      { englishTerm: 'tired', arabicMeaning: 'تعبان', exampleSentence: 'I am tired today.' },
      { englishTerm: 'busy', arabicMeaning: 'مشغول', exampleSentence: 'I was busy all day.' },
      { englishTerm: 'worked', arabicMeaning: 'اشتغلت', exampleSentence: 'I worked at the office.' },
    ],
    level: 'basic_conversation',
  },
  {
    slug: 'workplace_introduction',
    title: 'Simple workplace introductions',
    titleAr: 'التعريف في العمل',
    description: 'Introduce yourself to a new colleague or team.',
    topic: 'work',
    situationAr: 'في العمل، التعريف يكون أقصر وأكثر رسمية شوي من الكلام اليومي.',
    phrase: "I'm the new accountant. I joined this week.",
    phraseAr: 'أنا المحاسب الجديد. بدأت هالأسبوع.',
    phrase2: { english: 'Nice to meet you all.', arabic: 'تشرفت بمعرفتكم جميعاً.' },
    comprehension: {
      questionAr: 'وش معنى "I joined this week"؟',
      options: ['بدأت هالأسبوع', 'سافرت هالأسبوع', 'أنهيت هالأسبوع'],
      answerIndex: 0,
    },
    prompt: {
      slug: 'workplace_introduction_01',
      taskAr: 'عرّف بنفسك في العمل.',
      taskEn: 'Introduce yourself at work.',
      modelAnswer: "I'm the new accountant. I joined this week.",
      acceptedAnswers: ['I am the new accountant', 'I am new here I joined this week', 'I started this week I am the new accountant'],
      requiredKeywords: ['new'],
      hints: [
        {
          match: 'i am work here',
          suggested: 'I work here',
          type: 'grammar',
          explanationAr: 'الصح "I work here" بدون "am". الفعل "am" يجي مع الصفة: "I am new".',
        },
      ],
    },
    vocabulary: [
      { englishTerm: 'joined', arabicMeaning: 'بدأت/انضميت', exampleSentence: 'I joined this week.' },
      { englishTerm: 'colleague', arabicMeaning: 'زميل', exampleSentence: 'This is my colleague, Sara.' },
      { englishTerm: 'team', arabicMeaning: 'فريق', exampleSentence: 'I am on the finance team.' },
    ],
    level: 'simple_understanding',
  },
  {
    slug: 'asking_for_help',
    title: 'Asking for help',
    titleAr: 'طلب المساعدة',
    description: 'Ask someone to help you or repeat what they said.',
    topic: 'everyday',
    situationAr: 'ما فهمت؟ ما فيها شي، اسأل بأدب. الجملة هذي تنقذك في أي موقف.',
    phrase: 'Sorry, could you repeat that more slowly?',
    phraseAr: 'المعذرة، تقدر تعيدها بشويش؟',
    phrase2: { english: "I don't understand. Can you help me?", arabic: 'ما فهمت. تقدر تساعدني؟' },
    comprehension: {
      questionAr: 'وش تقول لما ما تفهم؟',
      options: ['Could you repeat that, please?', 'I am fine', 'See you later'],
      answerIndex: 0,
    },
    prompt: {
      slug: 'asking_for_help_01',
      taskAr: 'اطلب من شخص يعيد جملته بشويش.',
      taskEn: 'Ask someone to repeat slowly.',
      modelAnswer: 'Sorry, could you repeat that more slowly?',
      acceptedAnswers: ['Could you repeat that please', 'Can you say that again slowly', 'Sorry could you say it again'],
      requiredKeywords: ['repeat'],
      hints: [
        {
          match: 'say again',
          suggested: 'Could you repeat that?',
          type: 'style',
          explanationAr: '"Could you repeat that?" أكثر استخداماً وأأدب من "say again".',
        },
      ],
    },
    vocabulary: [
      { englishTerm: 'repeat', arabicMeaning: 'يعيد', exampleSentence: 'Could you repeat that?' },
      { englishTerm: 'slowly', arabicMeaning: 'بشويش', exampleSentence: 'Please speak slowly.' },
      { englishTerm: 'understand', arabicMeaning: 'يفهم', exampleSentence: "I don't understand." },
    ],
    level: 'few_words',
  },
  {
    slug: 'greetings_time_of_day',
    title: 'Greetings through the day',
    titleAr: 'التحيات في أوقات اليوم',
    description: 'Use the right greeting for the time of day.',
    topic: 'everyday',
    situationAr: 'التحية تختلف حسب الوقت. الصباح شي، وبعد الظهر شي ثاني.',
    phrase: 'Good morning! How are you today?',
    phraseAr: 'صباح الخير! كيف حالك اليوم؟',
    phrase2: { english: "I'm fine, thank you. And you?", arabic: 'أنا بخير، شكراً. وأنت؟' },
    comprehension: {
      questionAr: 'وش تقول في الصباح؟',
      options: ['Good morning', 'Good night', 'Goodbye'],
      answerIndex: 0,
    },
    prompt: {
      slug: 'greetings_time_of_day_01',
      taskAr: 'سلّم على شخص واسأله عن حاله.',
      taskEn: 'Greet someone and ask how they are.',
      modelAnswer: 'Good morning! How are you today?',
      acceptedAnswers: ['Good morning how are you', 'Hello how are you today', 'Good morning how are you doing today'],
      requiredKeywords: ['how are you'],
      hints: [
        {
          match: 'how you are',
          suggested: 'how are you',
          type: 'grammar',
          explanationAr: 'الترتيب الصح في السؤال: "how are you".',
        },
      ],
    },
    vocabulary: [
      { englishTerm: 'good morning', arabicMeaning: 'صباح الخير', exampleSentence: 'Good morning, everyone.' },
      { englishTerm: 'how are you', arabicMeaning: 'كيف حالك', exampleSentence: 'How are you today?' },
      { englishTerm: 'fine', arabicMeaning: 'بخير', exampleSentence: "I'm fine, thank you." },
    ],
    level: 'complete_beginner',
  },
  {
    slug: 'numbers_and_time',
    title: 'Numbers and telling the time',
    titleAr: 'الأرقام والوقت',
    description: 'Say prices, numbers and appointment times.',
    topic: 'everyday',
    situationAr: 'الأرقام تحتاجها كل يوم: السعر، الوقت، رقم الجوال. خلنا نتمرّن على الوقت.',
    phrase: 'The meeting is at half past nine.',
    phraseAr: 'الاجتماع الساعة تسعة والنصف.',
    phrase2: { english: 'It starts at seven in the evening.', arabic: 'يبدأ الساعة سبع بالليل.' },
    comprehension: {
      questionAr: 'وش معنى "half past nine"؟',
      options: ['تسعة والنصف', 'تسعة وربع', 'عشر إلا ربع'],
      answerIndex: 0,
    },
    prompt: {
      slug: 'numbers_and_time_01',
      taskAr: 'قل موعد اجتماع الساعة تسعة والنصف.',
      taskEn: 'Say a meeting time.',
      modelAnswer: 'The meeting is at half past nine.',
      acceptedAnswers: ['The meeting is at nine thirty', 'The meeting starts at 9 30', 'The meeting is at half nine'],
      requiredKeywords: ['meeting'],
      hints: [
        {
          match: 'in nine',
          suggested: 'at nine',
          type: 'grammar',
          explanationAr: 'مع الوقت نستخدم "at": "at nine".',
        },
      ],
    },
    vocabulary: [
      { englishTerm: 'half past', arabicMeaning: 'والنصف', exampleSentence: 'It is half past eight.' },
      { englishTerm: 'meeting', arabicMeaning: 'اجتماع', exampleSentence: 'The meeting is at nine.' },
      { englishTerm: 'evening', arabicMeaning: 'مساء', exampleSentence: 'I study in the evening.' },
    ],
    level: 'few_words',
  },
  {
    slug: 'job_interview_basics',
    title: 'Job interview basics',
    titleAr: 'أساسيات مقابلة العمل',
    description: 'Answer common interview questions simply and clearly.',
    topic: 'work',
    situationAr: 'في المقابلة، الجواب القصير الواضح أفضل من الطويل. تمرّن على تعريف خبرتك.',
    phrase: 'I have three years of experience in customer service.',
    phraseAr: 'عندي ثلاث سنوات خبرة في خدمة العملاء.',
    phrase2: { english: 'I am good at working with people.', arabic: 'أنا جيد في التعامل مع الناس.' },
    comprehension: {
      questionAr: 'وش معنى "experience"؟',
      options: ['خبرة', 'راتب', 'إجازة'],
      answerIndex: 0,
    },
    prompt: {
      slug: 'job_interview_basics_01',
      taskAr: 'تكلم عن خبرتك في مجال عملك.',
      taskEn: 'Talk about your experience.',
      modelAnswer: 'I have three years of experience in customer service.',
      acceptedAnswers: ['I have three years experience in customer service', 'I have experience in customer service', 'I worked three years in customer service'],
      requiredKeywords: ['experience'],
      hints: [
        {
          match: 'i have experience in customer',
          suggested: 'I have experience in customer service',
          type: 'missing_word',
          explanationAr: 'الشغلة اسمها "customer service" — كلمتين.',
        },
      ],
    },
    vocabulary: [
      { englishTerm: 'experience', arabicMeaning: 'خبرة', exampleSentence: 'I have five years of experience.' },
      { englishTerm: 'skills', arabicMeaning: 'مهارات', exampleSentence: 'My main skills are organisation and teamwork.' },
      { englishTerm: 'interview', arabicMeaning: 'مقابلة', exampleSentence: 'My interview is on Sunday.' },
    ],
    level: 'basic_conversation',
  },
  {
    slug: 'doctor_pharmacy',
    title: 'At the doctor and pharmacy',
    titleAr: 'عند الدكتور والصيدلية',
    description: 'Describe a simple symptom and ask for medicine.',
    topic: 'everyday',
    situationAr: 'لما تمرض في بلد يتكلم إنجليزي، تحتاج توصف العرض بجملة قصيرة.',
    phrase: 'I have a headache. Do you have anything for it?',
    phraseAr: 'عندي صداع. عندك شي له؟',
    phrase2: { english: 'I need to see a doctor.', arabic: 'أحتاج أشوف دكتور.' },
    comprehension: {
      questionAr: 'وش معنى "headache"؟',
      options: ['صداع', 'ألم بطن', 'حرارة'],
      answerIndex: 0,
    },
    prompt: {
      slug: 'doctor_pharmacy_01',
      taskAr: 'وصف عرض بسيط للصيدلي.',
      taskEn: 'Describe a simple symptom.',
      modelAnswer: 'I have a headache. Do you have anything for it?',
      acceptedAnswers: ['I have a headache', 'I have a headache do you have medicine', 'My head hurts do you have anything'],
      requiredKeywords: ['headache'],
      hints: [
        {
          match: 'my head is pain',
          suggested: 'I have a headache',
          type: 'word_choice',
          explanationAr: 'في الإنجليزي نقول "I have a headache" — أسهل وأصح من ترجمة "راسي يوجعني" حرفياً.',
        },
      ],
    },
    vocabulary: [
      { englishTerm: 'headache', arabicMeaning: 'صداع', exampleSentence: 'I have a headache.' },
      { englishTerm: 'medicine', arabicMeaning: 'دواء', exampleSentence: 'Do you have this medicine?' },
      { englishTerm: 'doctor', arabicMeaning: 'دكتور', exampleSentence: 'I need to see a doctor.' },
    ],
    level: 'few_words',
  },
  {
    slug: 'phone_call_basics',
    title: 'Simple phone calls',
    titleAr: 'مكالمات بسيطة',
    description: 'Answer the phone, ask who is calling, and leave a message.',
    topic: 'everyday',
    situationAr: 'في المكالمة ما تشوف الشخص، فالجملة لازم تكون واضحة من أول مرة.',
    phrase: 'Hello, this is Fahad speaking. Can I speak to Sara?',
    phraseAr: 'السلام عليكم، أنا فهد. أقدر أكلم سارة؟',
    phrase2: { english: 'Could you take a message, please?', arabic: 'تقدر توصل رسالة، لو سمحت؟' },
    comprehension: {
      questionAr: 'كيف تعرّف بنفسك في المكالمة؟',
      options: ['This is Fahad speaking', 'I am the phone', 'Hello goodbye'],
      answerIndex: 0,
    },
    prompt: {
      slug: 'phone_call_basics_01',
      taskAr: 'اتصل واسأل عن شخص.',
      taskEn: 'Ask to speak to someone.',
      modelAnswer: 'Hello, this is Fahad speaking. Can I speak to Sara?',
      acceptedAnswers: ['Hello can I speak to Sara', 'This is Fahad can I speak to Sara', 'Can I speak to Sara please'],
      requiredKeywords: ['speak'],
      hints: [
        {
          match: 'i want speak',
          suggested: 'Can I speak',
          type: 'grammar',
          explanationAr: 'الصح "Can I speak to" أو "I want to speak to" — لازم "to" قبل الفعل.',
        },
      ],
    },
    vocabulary: [
      { englishTerm: 'speaking', arabicMeaning: 'يتكلم', exampleSentence: 'This is Fahad speaking.' },
      { englishTerm: 'message', arabicMeaning: 'رسالة', exampleSentence: 'Could you take a message?' },
      { englishTerm: 'call back', arabicMeaning: 'يتصل مرة ثانية', exampleSentence: 'I will call back later.' },
    ],
    level: 'simple_understanding',
  },
  {
    slug: 'taxi_transport',
    title: 'Taxis and transport',
    titleAr: 'التاكسي والمواصلات',
    description: 'Tell a driver where to go and ask the fare.',
    topic: 'travel',
    situationAr: 'في التاكسي تحتاج جملتين: وين تبغى تروح، وكم الأجرة.',
    phrase: 'Please take me to the airport. How much will it cost?',
    phraseAr: 'ودّني المطار، لو سمحت. كم بتكلف؟',
    phrase2: { english: 'Could you stop here, please?', arabic: 'تقدر توقف هنا، لو سمحت؟' },
    comprehension: {
      questionAr: 'كيف تسأل عن الأجرة؟',
      options: ['How much will it cost?', 'Where are you from?', 'How old are you?'],
      answerIndex: 0,
    },
    prompt: {
      slug: 'taxi_transport_01',
      taskAr: 'قل للسواق وين تبغى تروح.',
      taskEn: 'Tell the driver where to go.',
      modelAnswer: 'Please take me to the airport.',
      acceptedAnswers: ['Take me to the airport please', 'Can you take me to the airport', 'Please go to the airport'],
      requiredKeywords: ['airport'],
      hints: [
        {
          match: 'take me airport',
          suggested: 'take me to the airport',
          type: 'missing_word',
          explanationAr: 'ناقص "to" و"the": "take me to the airport".',
        },
      ],
    },
    vocabulary: [
      { englishTerm: 'airport', arabicMeaning: 'مطار', exampleSentence: 'Take me to the airport, please.' },
      { englishTerm: 'cost', arabicMeaning: 'يكلف', exampleSentence: 'How much will it cost?' },
      { englishTerm: 'stop', arabicMeaning: 'يوقف', exampleSentence: 'Please stop here.' },
    ],
    level: 'few_words',
  },
  {
    slug: 'restaurant_reservation',
    title: 'Booking a table',
    titleAr: 'حجز طاولة',
    description: 'Book a table by phone or at the entrance.',
    topic: 'everyday',
    situationAr: 'تبغى تحجز طاولة لمجموعة؟ جملة واحدة تكفي.',
    phrase: "I'd like to book a table for four at eight o'clock.",
    phraseAr: 'أبغى أحجز طاولة لأربعة الساعة ثمانية.',
    phrase2: { english: 'Do you have a table by the window?', arabic: 'عندكم طاولة عند الشباك؟' },
    comprehension: {
      questionAr: 'وش معنى "a table for four"؟',
      options: ['طاولة لأربعة أشخاص', 'أربع طاولات', 'طاولة رقم أربعة'],
      answerIndex: 0,
    },
    prompt: {
      slug: 'restaurant_reservation_01',
      taskAr: 'احجز طاولة لأربعة أشخاص.',
      taskEn: 'Book a table for four.',
      modelAnswer: "I'd like to book a table for four at eight o'clock.",
      acceptedAnswers: ['I would like to book a table for four', 'Id like a table for four at eight', 'Can I book a table for four'],
      requiredKeywords: ['table'],
      hints: [
        {
          match: 'i want book',
          suggested: "I'd like to book",
          type: 'grammar',
          explanationAr: 'بعد want أو would like يجي "to": "I\'d like to book".',
        },
      ],
    },
    vocabulary: [
      { englishTerm: 'book a table', arabicMeaning: 'يحجز طاولة', exampleSentence: "I'd like to book a table for two." },
      { englishTerm: 'for four', arabicMeaning: 'لأربعة أشخاص', exampleSentence: 'A table for four, please.' },
      { englishTerm: 'window', arabicMeaning: 'شباك', exampleSentence: 'A table by the window, please.' },
    ],
    level: 'simple_understanding',
  },
  {
    slug: 'weather_small_talk',
    title: 'Weather and small talk',
    titleAr: 'الطقس والكلام الخفيف',
    description: 'Make simple small talk about the weather.',
    topic: 'everyday',
    situationAr: 'الطقس أسهل موضوع للكلام الخفيف — ويفتح أي محادثة.',
    phrase: "It's very hot today. Is it always like this?",
    phraseAr: 'الجو حار مرة اليوم. دايماً كذا؟',
    phrase2: { english: 'I hope it rains soon.', arabic: 'إن شاء الله تمطر قريب.' },
    comprehension: {
      questionAr: 'وش معنى "very hot"؟',
      options: ['حار مرة', 'بارد مرة', 'غائم'],
      answerIndex: 0,
    },
    prompt: {
      slug: 'weather_small_talk_01',
      taskAr: 'تكلم عن الطقس مع شخص.',
      taskEn: 'Talk about the weather.',
      modelAnswer: "It's very hot today. Is it always like this?",
      acceptedAnswers: ['It is very hot today', 'Today is very hot is it always like this', 'The weather is very hot today'],
      requiredKeywords: ['hot'],
      hints: [
        {
          match: 'it is very hot today is it always like this',
          suggested: "It's very hot today. Is it always like this?",
          type: 'style',
          explanationAr: 'في الكلام نقصر "It is" إلى "It\'s" — أسرع وأطبيعي.',
        },
      ],
    },
    vocabulary: [
      { englishTerm: 'hot', arabicMeaning: 'حار', exampleSentence: "It's hot today." },
      { englishTerm: 'cold', arabicMeaning: 'بارد', exampleSentence: "It's cold in the morning." },
      { englishTerm: 'rain', arabicMeaning: 'مطر', exampleSentence: 'It will rain tonight.' },
    ],
    level: 'few_words',
  },
  {
    slug: 'describing_family',
    title: 'Describing your family',
    titleAr: 'الكلام عن العائلة',
    description: 'Say who is in your family and their ages.',
    topic: 'everyday',
    situationAr: 'العائلة موضوع مريح في أي محادثة، والجمل بسيطة.',
    phrase: 'I have two brothers and one sister.',
    phraseAr: 'عندي أخوين وأخت وحدة.',
    phrase2: { english: 'My sister is a teacher.', arabic: 'أختي مدرّسة.' },
    comprehension: {
      questionAr: 'وش معنى "brothers"؟',
      options: ['أخوين/إخوان', 'أخواني الأصدقاء', 'عمامي'],
      answerIndex: 0,
    },
    prompt: {
      slug: 'describing_family_01',
      taskAr: 'تكلم عن عائلتك بجملة.',
      taskEn: 'Talk about your family.',
      modelAnswer: 'I have two brothers and one sister.',
      acceptedAnswers: ['I have two brothers and one sister', 'I have two brothers and a sister', 'I have one sister and two brothers'],
      requiredKeywords: ['brothers'],
      hints: [
        {
          match: 'i have two brothers and one sister',
          suggested: 'I have two brothers and one sister.',
          type: 'style',
          explanationAr: 'ممتاز! غالباً نقول "a sister" بدل "one sister" في الكلام اليومي.',
        },
      ],
    },
    vocabulary: [
      { englishTerm: 'brother', arabicMeaning: 'أخ', exampleSentence: 'I have two brothers.' },
      { englishTerm: 'sister', arabicMeaning: 'أخت', exampleSentence: 'My sister is a teacher.' },
      { englishTerm: 'family', arabicMeaning: 'عائلة', exampleSentence: 'My family is big.' },
    ],
    level: 'complete_beginner',
  },
  {
    slug: 'asking_about_prices_negotiating',
    title: 'Shopping for clothes',
    titleAr: 'شراء ملابس',
    description: 'Ask for a size, try something on, and check the price.',
    topic: 'everyday',
    situationAr: 'تبغى تشتري ثوب أو قميص؟ تحتاج تسأل عن المقاس والسعر.',
    phrase: 'Do you have this in a larger size?',
    phraseAr: 'عندك هذا بمقاس أكبر؟',
    phrase2: { english: 'Is there a discount on this?', arabic: 'عليه خصم؟' },
    comprehension: {
      questionAr: 'وش معنى "larger size"؟',
      options: ['مقاس أكبر', 'سعر أعلى', 'لون ثاني'],
      answerIndex: 0,
    },
    prompt: {
      slug: 'shopping_clothes_01',
      taskAr: 'اسأل عن مقاس أكبر.',
      taskEn: 'Ask for a larger size.',
      modelAnswer: 'Do you have this in a larger size?',
      acceptedAnswers: ['Do you have this in a bigger size', 'Is there a larger size', 'Do you have a larger size in this'],
      requiredKeywords: ['size'],
      hints: [
        {
          match: 'do you have this larger size',
          suggested: 'Do you have this in a larger size?',
          type: 'missing_word',
          explanationAr: 'ناقص "in a": "in a larger size".',
        },
      ],
    },
    vocabulary: [
      { englishTerm: 'size', arabicMeaning: 'مقاس', exampleSentence: 'What size do you need?' },
      { englishTerm: 'larger', arabicMeaning: 'أكبر', exampleSentence: 'Do you have a larger size?' },
      { englishTerm: 'discount', arabicMeaning: 'خصم', exampleSentence: 'Is there a discount?' },
    ],
    level: 'simple_understanding',
  },
  {
    slug: 'hotel_problems',
    title: 'Reporting a problem in a hotel',
    titleAr: 'الإبلاغ عن مشكلة في الفندق',
    description: 'Say something is not working and ask for it to be fixed.',
    topic: 'travel',
    situationAr: 'في الفندق، إذا شي ما يشتغل، تبلّغ الاستقبال بجملة واضحة ومهذبة.',
    phrase: 'The air conditioner is not working. Could you send someone?',
    phraseAr: 'المكيف ما يشتغل. تقدرون ترسلون أحد؟',
    phrase2: { english: 'Could I change rooms?', arabic: 'أقدر أغيّر الغرفة؟' },
    comprehension: {
      questionAr: 'وش معنى "not working"؟',
      options: ['ما يشتغل', 'يشتغل زين', 'جديد'],
      answerIndex: 0,
    },
    prompt: {
      slug: 'hotel_problems_01',
      taskAr: 'بلّغ عن شي ما يشتغل في الغرفة.',
      taskEn: 'Report something not working.',
      modelAnswer: 'The air conditioner is not working. Could you send someone?',
      acceptedAnswers: ['The air conditioner is not working', 'The AC is not working could you send someone', 'My room air conditioner is broken'],
      requiredKeywords: ['not working'],
      hints: [
        {
          match: 'the air conditioner no work',
          suggested: 'The air conditioner is not working',
          type: 'grammar',
          explanationAr: 'في الإنجليزي نستخدم "is not working" بدل "no work".',
        },
      ],
    },
    vocabulary: [
      { englishTerm: 'not working', arabicMeaning: 'ما يشتغل', exampleSentence: 'The TV is not working.' },
      { englishTerm: 'send someone', arabicMeaning: 'ترسلون أحد', exampleSentence: 'Could you send someone to fix it?' },
      { englishTerm: 'change rooms', arabicMeaning: 'يغيّر الغرفة', exampleSentence: 'Could I change rooms?' },
    ],
    level: 'basic_conversation',
  },
  {
    slug: 'work_email_phrases',
    title: 'Useful work phrases',
    titleAr: 'جمل مفيدة في العمل',
    description: 'Ask a colleague for something and confirm a deadline.',
    topic: 'work',
    situationAr: 'في العمل، الجمل المهذبة القصيرة تخلص الشغل أسرع.',
    phrase: 'Could you send me the report by Thursday?',
    phraseAr: 'تقدر ترسل لي التقرير قبل الخميس؟',
    phrase2: { english: 'I will follow up tomorrow.', arabic: 'أتابع معك بكرة.' },
    comprehension: {
      questionAr: 'وش معنى "by Thursday"؟',
      options: ['قبل الخميس', 'يوم الخميس بالضبط', 'بعد الخميس'],
      answerIndex: 0,
    },
    prompt: {
      slug: 'work_email_phrases_01',
      taskAr: 'اطلب من زميل يرسل لك التقرير.',
      taskEn: 'Ask a colleague for a report.',
      modelAnswer: 'Could you send me the report by Thursday?',
      acceptedAnswers: ['Could you send me the report by Thursday', 'Can you send me the report before Thursday', 'Please send me the report by Thursday'],
      requiredKeywords: ['report'],
      hints: [
        {
          match: 'send me the report in thursday',
          suggested: 'send me the report by Thursday',
          type: 'grammar',
          explanationAr: 'للموعد النهائي نستخدم "by": "by Thursday".',
        },
      ],
    },
    vocabulary: [
      { englishTerm: 'report', arabicMeaning: 'تقرير', exampleSentence: 'Could you send me the report?' },
      { englishTerm: 'deadline', arabicMeaning: 'الموعد النهائي', exampleSentence: 'The deadline is Thursday.' },
      { englishTerm: 'follow up', arabicMeaning: 'يتابع', exampleSentence: 'I will follow up tomorrow.' },
    ],
    level: 'basic_conversation',
  },
  {
    slug: 'bank_and_money',
    title: 'Bank and money basics',
    titleAr: 'البنك والفلوس',
    description: 'Change money, open an account, and ask about fees.',
    topic: 'study',
    situationAr: 'تحتاج تصرف فلوس أو تسأل عن رسوم؟ الجمل هذي تنفع في أي بنك.',
    phrase: 'I would like to exchange some money. What is the rate today?',
    phraseAr: 'أبغى أصرف فلوس. وش سعر الصرف اليوم؟',
    phrase2: { english: 'Is there a fee for this?', arabic: 'فيه رسوم على هذا؟' },
    comprehension: {
      questionAr: 'وش معنى "the rate"؟',
      options: ['سعر الصرف', 'الرصيد', 'الرسوم'],
      answerIndex: 0,
    },
    prompt: {
      slug: 'bank_and_money_01',
      taskAr: 'اطلب صرف فلوس واسأل عن السعر.',
      taskEn: 'Ask to exchange money.',
      modelAnswer: 'I would like to exchange some money. What is the rate today?',
      acceptedAnswers: ['I would like to exchange some money', 'I want to change money what is the rate', 'Can I exchange money here what is the rate today'],
      requiredKeywords: ['exchange'],
      hints: [
        {
          match: 'i want exchange money',
          suggested: 'I would like to exchange some money',
          type: 'grammar',
          explanationAr: 'بعد want / would like يجي "to": "want to exchange".',
        },
      ],
    },
    vocabulary: [
      { englishTerm: 'exchange', arabicMeaning: 'يصرّف', exampleSentence: 'I would like to exchange money.' },
      { englishTerm: 'rate', arabicMeaning: 'سعر الصرف', exampleSentence: 'What is the rate today?' },
      { englishTerm: 'fee', arabicMeaning: 'رسوم', exampleSentence: 'Is there a fee?' },
    ],
    level: 'simple_understanding',
  },
  {
    slug: 'university_english',
    title: 'English for university',
    titleAr: 'الإنجليزي في الجامعة',
    description: 'Ask about a lecture, a deadline, and group work.',
    topic: 'study',
    situationAr: 'في الجامعة، تحتاج تسأل الدكتور أو زميلك عن المحاضرة والتسليم.',
    phrase: 'Excuse me, when is the assignment due?',
    phraseAr: 'لو سمحت، متى آخر موعد للتسليم؟',
    phrase2: { english: 'Can I join your study group?', arabic: 'أقدر أنضم لمجموعة الدراسة؟' },
    comprehension: {
      questionAr: 'وش معنى "due"؟',
      options: ['آخر موعد', 'الدرجة', 'المحاضرة'],
      answerIndex: 0,
    },
    prompt: {
      slug: 'university_english_01',
      taskAr: 'اسأل عن آخر موعد لتسليم الواجب.',
      taskEn: 'Ask when the assignment is due.',
      modelAnswer: 'Excuse me, when is the assignment due?',
      acceptedAnswers: ['When is the assignment due', 'When is the homework due', 'Excuse me when do we submit the assignment'],
      requiredKeywords: ['due'],
      hints: [
        {
          match: 'when the assignment is due',
          suggested: 'when is the assignment due',
          type: 'grammar',
          explanationAr: 'في السؤال نقدّم الفعل: "when is the assignment due".',
        },
      ],
    },
    vocabulary: [
      { englishTerm: 'assignment', arabicMeaning: 'واجب/تكليف', exampleSentence: 'The assignment is due on Sunday.' },
      { englishTerm: 'lecture', arabicMeaning: 'محاضرة', exampleSentence: 'The lecture starts at ten.' },
      { englishTerm: 'study group', arabicMeaning: 'مجموعة دراسة', exampleSentence: 'Can I join your study group?' },
    ],
    level: 'simple_understanding',
  },
  {
    slug: 'apologising_and_being_polite',
    title: 'Apologising and being polite',
    titleAr: 'الاعتذار واللباقة',
    description: 'Apologise, excuse yourself, and respond politely.',
    topic: 'everyday',
    situationAr: 'اللباقة في الإنجليزي بسيطة: Sorry، وExcuse me، وThank you. بس خلنا نتمرّن عليها.',
    phrase: "I'm sorry, that was my mistake. It won't happen again.",
    phraseAr: 'آسف، الغلط مني. ما تتكرر.',
    phrase2: { english: 'No problem at all.', arabic: 'ما فيها شي أبداً.' },
    comprehension: {
      questionAr: 'وش معنى "It won\'t happen again"؟',
      options: ['ما تتكرر', 'صار مرة ثانية', 'ما أدري'],
      answerIndex: 0,
    },
    prompt: {
      slug: 'apologising_01',
      taskAr: 'اعتذر عن غلط صار.',
      taskEn: 'Apologise for a mistake.',
      modelAnswer: "I'm sorry, that was my mistake. It won't happen again.",
      acceptedAnswers: ['I am sorry that was my mistake', 'Sorry my mistake it will not happen again', 'Im sorry it was my fault'],
      requiredKeywords: ['sorry'],
      hints: [
        {
          match: 'i am sorry i am mistake',
          suggested: 'I am sorry, that was my mistake',
          type: 'grammar',
          explanationAr: 'الغلط "was my mistake" — نستخدم was لأنها صارت وانتهت.',
        },
      ],
    },
    vocabulary: [
      { englishTerm: 'sorry', arabicMeaning: 'آسف', exampleSentence: "I'm sorry about that." },
      { englishTerm: 'mistake', arabicMeaning: 'غلط', exampleSentence: 'That was my mistake.' },
      { englishTerm: 'no problem', arabicMeaning: 'ما فيها شي', exampleSentence: 'No problem at all.' },
    ],
    level: 'few_words',
  },
  {
    slug: 'making_plans',
    title: 'Making plans with someone',
    titleAr: 'الاتفاق على موعد',
    description: 'Suggest a time to meet and answer a suggestion.',
    topic: 'everyday',
    situationAr: 'تبغى تتفق مع صاحبك على وقت؟ جملتين وتضبط الأمور.',
    phrase: 'Are you free on Friday? We could meet at six.',
    phraseAr: 'أنت فاضي الجمعة؟ نقدر نتقابل الساعة ستة.',
    phrase2: { english: "That sounds great. See you then.", arabic: 'تمام. أشوفك وقتها.' },
    comprehension: {
      questionAr: 'وش معنى "Are you free"؟',
      options: ['أنت فاضي؟', 'أنت مشغول؟', 'أنت وين؟'],
      answerIndex: 0,
    },
    prompt: {
      slug: 'making_plans_01',
      taskAr: 'اقترح موعد تتفقون عليه.',
      taskEn: 'Suggest a time to meet.',
      modelAnswer: 'Are you free on Friday? We could meet at six.',
      acceptedAnswers: ['Are you free on Friday', 'Are you free on Friday we could meet at six', 'Do you want to meet on Friday at six'],
      requiredKeywords: ['friday'],
      hints: [
        {
          match: 'are you free in friday',
          suggested: 'Are you free on Friday',
          type: 'grammar',
          explanationAr: 'مع أيام الأسبوع نستخدم "on": "on Friday".',
        },
      ],
    },
    vocabulary: [
      { englishTerm: 'free', arabicMeaning: 'فاضي', exampleSentence: 'Are you free tomorrow?' },
      { englishTerm: 'meet', arabicMeaning: 'يتقابل', exampleSentence: 'We could meet at six.' },
      { englishTerm: 'sounds great', arabicMeaning: 'تمام/حلو', exampleSentence: 'That sounds great.' },
    ],
    level: 'simple_understanding',
  },
  {
    slug: 'describing_work_daily_routine',
    title: 'Describing your daily routine',
    titleAr: 'وصف روتينك اليومي',
    description: 'Talk about what you do every day, with times.',
    topic: 'work',
    situationAr: 'لما يسألونك عن يومك العادي، تستخدم زمن المضارع البسيط. تمرّن على الترتيب.',
    phrase: 'I usually start work at eight and finish at five.',
    phraseAr: 'عادةً أبدأ الشغل الساعة ثمانية وأخلص خمسة.',
    phrase2: { english: 'After work, I go to the gym.', arabic: 'بعد الشغل أروح النادي.' },
    comprehension: {
      questionAr: 'وش معنى "usually"؟',
      options: ['عادةً', 'أبداً', 'أحياناً'],
      answerIndex: 0,
    },
    prompt: {
      slug: 'daily_routine_01',
      taskAr: 'اوصف روتينك في العمل.',
      taskEn: 'Describe your work routine.',
      modelAnswer: 'I usually start work at eight and finish at five.',
      acceptedAnswers: ['I usually start work at eight and finish at five', 'I start work at eight and finish at five', 'I usually begin work at 8 and finish at 5'],
      requiredKeywords: ['start'],
      hints: [
        {
          match: 'i am start work',
          suggested: 'I start work',
          type: 'grammar',
          explanationAr: 'الروتين اليومي بالمضارع البسيط بدون "am": "I start work".',
        },
      ],
    },
    vocabulary: [
      { englishTerm: 'usually', arabicMeaning: 'عادةً', exampleSentence: 'I usually wake up early.' },
      { englishTerm: 'start', arabicMeaning: 'يبدأ', exampleSentence: 'I start work at eight.' },
      { englishTerm: 'finish', arabicMeaning: 'يخلص', exampleSentence: 'I finish at five.' },
    ],
    level: 'basic_conversation',
  },
];

export const SEED_LESSONS: Lesson[] = SEEDS.map(build);

/** Content sanity: every published lesson must be evaluable by rules alone. */
export function validateLessonContent(lesson: Lesson): string[] {
  const problems: string[] = [];
  if (lesson.title !== '' && lesson.titleAr === '') problems.push('missing Arabic title');
  if (!lesson.content || lesson.content.steps.length === 0) problems.push('no steps');
  if (!lesson.content || lesson.content.speakingPrompts.length === 0) problems.push('no speaking prompt');
  for (const prompt of lesson.content?.speakingPrompts ?? []) {
    if (prompt.modelAnswer.trim() === '') problems.push(`prompt ${prompt.slug} has no model answer`);
    if (prompt.acceptedAnswers.length === 0) problems.push(`prompt ${prompt.slug} has no accepted answers`);
    if (prompt.requiredKeywords.length === 0) problems.push(`prompt ${prompt.slug} has no required keywords`);
  }
  if (lesson.content && lesson.content.vocabulary.length === 0) problems.push('no vocabulary');
  return problems;
}
