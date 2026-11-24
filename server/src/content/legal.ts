/**
 * Privacy policy, terms and the public account-deletion page.
 *
 * Two hard requirements drive this file:
 *
 *  1. build (1).md §10.1 — "The privacy policy must state these durations in
 *     plain Arabic and English." So the durations are NOT written as prose here:
 *     they are read from the same `RetentionPolicy` the retention job executes.
 *     A policy that promises 90 days while the job clears at 30 is a false
 *     statement, and duplicating the numbers is how that drift starts.
 *
 *  2. Google Play requires an app that supports account creation to offer a
 *     PUBLIC web path for deletion requests — reachable by someone who has
 *     already uninstalled the app and cannot sign in. That is why these routes
 *     are unauthenticated HTML pages rather than JSON endpoints behind auth.
 *
 * Every statement here describes behaviour that exists in this codebase
 * (see docs/development-log.md). Nothing is aspirational.
 */
import type { RetentionPolicy } from '../services/retention/RetentionService.ts';

export interface LegalConfig {
  appName: string;
  /** Where a person asks a question or requests deletion without the app. */
  supportEmail: string;
  /** ISO date the current text took effect. */
  effectiveDate: string;
  /** The same policy object the retention job runs against. */
  retention: RetentionPolicy;
}

export interface LegalDoc {
  slug: 'privacy' | 'terms' | 'delete-account';
  titleAr: string;
  titleEn: string;
  sections: Array<{ headingAr: string; headingEn: string; bodyAr: string; bodyEn: string }>;
}

/**
 * Dates are shown to users, so they are formatted in one place. `split()[0]` is
 * typed `string | undefined` under `noUncheckedIndexedAccess`, hence the fallback.
 */
function dateOnly(iso: string): string {
  const [date] = iso.split('T');
  return date ?? iso;
}

/**
 * Renders the retention schedule from the live policy. Each entry is a promise
 * the user can hold the operator to, so the numbers must come from config.
 */
export function retentionSchedule(config: LegalConfig): Array<{
  dataAr: string;
  dataEn: string;
  periodAr: string;
  periodEn: string;
}> {
  const r = config.retention;
  return [
    {
      dataAr: 'تسجيل صوتك',
      dataEn: 'Your voice recording',
      periodAr: 'يُحذف فور الانتهاء من التحويل، ولا يُحفظ في قاعدة البيانات ولا في التخزين',
      periodEn: 'Deleted as soon as transcription returns; never written to the database or object storage',
    },
    {
      dataAr: 'النص المكتوب لإجابتك',
      dataEn: 'The transcript of your answer',
      periodAr: `يُحفظ ${r.transcriptDays} يوماً ثم يُحذف تلقائياً`,
      periodEn: `Kept for ${r.transcriptDays} days, then cleared automatically`,
    },
    {
      dataAr: 'نتيجة التصحيح',
      dataEn: 'The correction result',
      periodAr: `يُحفظ ${r.evaluationDays} يوماً أو حتى حذف حسابك، أيهما أسبق`,
      periodEn: `Kept for ${r.evaluationDays} days, or until you delete your account — whichever comes first`,
    },
    {
      dataAr: 'سجل الاستخدام (بدون صوت أو نص)',
      dataEn: 'Usage records (no audio, no transcript)',
      periodAr: `يُحفظ ${r.usageEventMonths} شهراً`,
      periodEn: `Kept for ${r.usageEventMonths} months`,
    },
    {
      dataAr: 'سجل موافقتك على معالجة الصوت',
      dataEn: 'Your consent record',
      periodAr: `يُحفظ مدة استخدامك للتطبيق و${r.consentMonthsAfterWithdrawal} شهراً بعد سحب الموافقة`,
      periodEn: `Kept while you use the app, and for ${r.consentMonthsAfterWithdrawal} months after you withdraw consent`,
    },
    {
      dataAr: 'ملفك الشخصي',
      dataEn: 'Your profile',
      periodAr: `يُحذف نهائياً بعد ${r.profileGraceDays} يوماً من طلبك (مدة سماح لو تراجعت عن الطلب)`,
      periodEn: `Permanently deleted ${r.profileGraceDays} days after your request (a grace period in case you change your mind)`,
    },
  ];
}

export function privacyDoc(config: LegalConfig): LegalDoc {
  const r = config.retention;
  return {
    slug: 'privacy',
    titleAr: 'سياسة الخصوصية',
    titleEn: 'Privacy Policy',
    sections: [
      {
        headingAr: 'من نحن',
        headingEn: 'Who we are',
        bodyAr: `${config.appName} تطبيق لتعليم الإنجليزية للناطقين بالعربية، بشرح بالعربي السعودي وتدريب على الكلام.`,
        bodyEn: `${config.appName} teaches English to Arabic speakers, with explanations in Saudi Arabic and speaking practice.`,
      },
      {
        headingAr: 'وش نجمع',
        headingEn: 'What we collect',
        bodyAr:
          'نجمع الحد الأدنى فقط: بريدك الإلكتروني لتسجيل الدخول، واسم عرض اختياري، ومستواك وهدفك اليومي، وتقدمك في الدروس، والكلمات التي حفظتها، والنص والتصحيح الخاص بتدريبات الكلام. ' +
          'ما نطلب تاريخ ميلادك ولا موقعك الدقيق ولا جهات الاتصال ولا صورك.',
        bodyEn:
          'We collect the minimum: your email to sign in, an optional display name, your level and daily goal, your lesson progress, the words you saved, and the transcript and correction for speaking exercises. ' +
          'We never ask for your date of birth, precise location, contacts or photos.',
      },
      {
        headingAr: 'صوتك',
        headingEn: 'Your voice',
        bodyAr:
          'التسجيل يُرسل إلى خدمة HUMAIN Voice لتحويله إلى نص، ولا يُحفظ عندنا. إلا إذا وافقت على معالجة الصوت، ما نفتح الميكروفون نهائياً. ' +
          'وتقدر تسحب موافقتك في أي وقت من الإعدادات، وساعتها يتوقف إرسال أي صوت فوراً.',
        bodyEn:
          'Your recording is sent to the HUMAIN Voice service to be turned into text, and is not stored by us. We do not open the microphone at all unless you have consented to voice processing. ' +
          'You can withdraw consent at any time in settings, and audio processing stops immediately when you do.',
      },
      {
        headingAr: 'مدة الحفظ',
        headingEn: 'How long we keep things',
        bodyAr: `كل نوع من البيانات له مدة محددة، ونشغّل مهمة مجدولة تحذف ما انتهت مدته:\n${retentionSchedule(config)
          .map((row) => `• ${row.dataAr}: ${row.periodAr}.`)
          .join('\n')}`,
        bodyEn: `Each type of data has a defined period, and a scheduled job deletes what has expired:\n${retentionSchedule(config)
          .map((row) => `• ${row.dataEn}: ${row.periodEn}.`)
          .join('\n')}`,
      },
      {
        headingAr: 'حذف حسابك',
        headingEn: 'Deleting your account',
        bodyAr:
          'تقدر تحذف حسابك من داخل التطبيق (الإعدادات ← حذف الحساب). ' +
          `الحذف فوري للجلسات، ثم تُمسح كل بياناتك نهائياً بعد ${r.profileGraceDays} يوماً.`,
        bodyEn:
          'You can delete your account inside the app (Settings → Delete account). ' +
          `Sessions end immediately, and all your data is permanently removed ${r.profileGraceDays} days later.`,
      },
      {
        headingAr: 'حقوقك',
        headingEn: 'Your rights',
        bodyAr:
          'تقدر تطلب نسخة من بياناتك، أو تصحيحها، أو حذفها، أو تسحب موافقتك على الصوت. راسلنا ونرد عليك.',
        bodyEn:
          'You can ask for a copy of your data, ask us to correct it, ask us to delete it, or withdraw your voice consent. Contact us and we will respond.',
      },
      {
        headingAr: 'الجهات الخارجية',
        headingEn: 'Third parties',
        bodyAr:
          'نستخدم HUMAIN Voice لتحويل الكلام إلى نص وتوليد الصوت، و Supabase لتخزين الحساب والتقدم. نرسل لهم ما يلزم للخدمة فقط، وما نبيع بياناتك ولا نستخدم شبكات إعلانات.',
        bodyEn:
          'We use HUMAIN Voice for speech-to-text and generated audio, and Supabase for account and progress storage. We send them only what the service requires, we do not sell your data, and we run no advertising networks.',
      },
      {
        headingAr: 'الأطفال',
        headingEn: 'Children',
        bodyAr: 'التطبيق موجه لمن عمره 18 سنة وأكثر في هذه المرحلة.',
        bodyEn: 'This version of the app is intended for people aged 18 and over.',
      },
      {
        headingAr: 'التواصل',
        headingEn: 'Contact',
        bodyAr: config.supportEmail
          ? `لأي سؤال عن الخصوصية: ${config.supportEmail}`
          : 'راسلنا عبر صفحة الدعم في التطبيق.',
        bodyEn: config.supportEmail
          ? `For any privacy question: ${config.supportEmail}`
          : 'Contact us through the support page in the app.',
      },
      {
        headingAr: 'سريان هذه السياسة',
        headingEn: 'When this applies',
        bodyAr: `آخر تحديث: ${dateOnly(config.effectiveDate)}.`,
        bodyEn: `Last updated: ${dateOnly(config.effectiveDate)}.`,
      },
    ],
  };
}

export function termsDoc(config: LegalConfig): LegalDoc {
  return {
    slug: 'terms',
    titleAr: 'شروط الاستخدام',
    titleEn: 'Terms of Service',
    sections: [
      {
        headingAr: 'الخدمة',
        headingEn: 'The service',
        bodyAr: `${config.appName} يعلّمك الإنجليزية بشرح بالعربي السعودي وتمارين كلام. الخدمة تعليمية، وما تمنح شهادة مستوى ولا تضمن إتقان اللغة.`,
        bodyEn: `${config.appName} teaches English with Saudi Arabic explanations and speaking exercises. It is an educational service: it does not grant a proficiency certificate and does not promise fluency.`,
      },
      {
        headingAr: 'حسابك',
        headingEn: 'Your account',
        bodyAr: 'أنت مسؤول عن حماية كلمة المرور. لا تشارك حسابك مع غيرك.',
        bodyEn: 'You are responsible for keeping your password safe. Do not share your account with others.',
      },
      {
        headingAr: 'الاستخدام المقبول',
        headingEn: 'Acceptable use',
        bodyAr: 'لا تستخدم التطبيق لمضايقة أحد، ولا تحاول الوصول لبيانات غيره، ولا تعيد بيع المحتوى.',
        bodyEn: 'Do not use the app to harass anyone, do not attempt to reach another person’s data, and do not resell the content.',
      },
      {
        headingAr: 'حدود الاستخدام',
        headingEn: 'Usage limits',
        bodyAr: 'تمارين الكلام لها حد يومي، لحماية الخدمة من التكاليف. نوضح لك الحد داخل التطبيق.',
        bodyEn: 'Speaking exercises have a daily limit to protect the service from cost abuse. The limit is shown inside the app.',
      },
      {
        headingAr: 'توقف الخدمة',
        headingEn: 'Ending the service',
        bodyAr: 'تقدر تحذف حسابك في أي وقت. ونقدر نوقف حساباً يخالف هذه الشروط.',
        bodyEn: 'You may delete your account at any time. We may suspend an account that breaks these terms.',
      },
      {
        headingAr: 'سريان هذه الشروط',
        headingEn: 'When this applies',
        bodyAr: `آخر تحديث: ${dateOnly(config.effectiveDate)}.`,
        bodyEn: `Last updated: ${dateOnly(config.effectiveDate)}.`,
      },
    ],
  };
}

export function deletionDoc(config: LegalConfig): LegalDoc {
  const grace = config.retention.profileGraceDays;
  return {
    slug: 'delete-account',
    titleAr: 'حذف الحساب والبيانات',
    titleEn: 'Delete your account and data',
    sections: [
      {
        headingAr: 'من داخل التطبيق',
        headingEn: 'Inside the app',
        bodyAr: `افتح ${config.appName}، ثم الإعدادات (الحساب)، ثم «حذف الحساب». تنتهي جلساتك فوراً، وتُمسح بياناتك نهائياً بعد ${grace} يوماً.`,
        bodyEn: `Open ${config.appName}, go to Settings (Account), then "Delete account". Your sessions end immediately, and your data is permanently removed ${grace} days later.`,
      },
      {
        headingAr: 'بدون التطبيق',
        headingEn: 'Without the app',
        bodyAr: config.supportEmail
          ? `إذا حذفت التطبيق أو ما تقدر تسجّل دخول، راسلنا من البريد الذي سجّلت به على ${config.supportEmail} واكتب في العنوان «حذف الحساب». نتحقق من ملكية البريد، ثم نحذف الحساب.`
          : 'راسلنا من البريد الذي سجّلت به واكتب في العنوان «حذف الحساب». نتحقق من ملكية البريد، ثم نحذف الحساب.',
        bodyEn: config.supportEmail
          ? `If you uninstalled the app or cannot sign in, email us from the address you registered with at ${config.supportEmail} with the subject "Delete account". We verify you own that address, then delete the account.`
          : 'Email us from the address you registered with, with the subject "Delete account". We verify you own that address, then delete the account.',
      },
      {
        headingAr: 'وش ينحذف',
        headingEn: 'What gets deleted',
        bodyAr: 'حسابك، وملفك الشخصي، وتقدمك، وكلماتك المحفوظة، والنصوص والتصحيحات، وسجل موافقتك. نُبقي سجل استخدام مجهول الهوية (بدون أي ربط بك) لأغراض المحاسبة فقط.',
        bodyEn:
          'Your account, profile, progress, saved words, transcripts, corrections and consent record. We keep only an anonymised usage ledger — with no link to you — for accounting purposes.',
      },
      {
        headingAr: 'متى ينحذف',
        headingEn: 'When it gets deleted',
        bodyAr: `جلساتك تنتهي فوراً عند الطلب. والمسح النهائي يتم بعد ${grace} يوماً، عشان لو تراجعت عن الطلب نقدر نرجّع حسابك. بعدها ما نقدر نرجّعه.`,
        bodyEn: `Your sessions end as soon as you request deletion. Final removal happens after ${grace} days so the request is reversible if you change your mind. After that it cannot be recovered.`,
      },
    ],
  };
}

export function allDocs(config: LegalConfig): LegalDoc[] {
  return [privacyDoc(config), termsDoc(config), deletionDoc(config)];
}

/** Minimal, framework-free HTML. No script, no external asset, no tracker. */
export function renderDocPage(config: LegalConfig, doc: LegalDoc): string {
  const esc = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const body = (text: string) => esc(text).replace(/\n/g, '<br>');
  const sections = doc.sections
    .map(
      (s) => `
      <section>
        <h2><span lang="ar" dir="rtl">${esc(s.headingAr)}</span> <small>· ${esc(s.headingEn)}</small></h2>
        <p lang="ar" dir="rtl">${body(s.bodyAr)}</p>
        <p lang="en" dir="ltr">${body(s.bodyEn)}</p>
      </section>`,
    )
    .join('');
  const nav = allDocs(config)
    .map((d) => `<a href="/legal/${d.slug}">${esc(d.titleEn)} / <span lang="ar">${esc(d.titleAr)}</span></a>`)
    .join(' · ');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(doc.titleEn)} — ${esc(config.appName)}</title>
<style>
 :root{color-scheme:light dark}
 body{margin:0;padding:2rem 1rem;font:16px/1.7 system-ui,-apple-system,"Segoe UI",sans-serif;max-width:44rem;margin-inline:auto}
 h1{font-size:1.6rem;margin:0 0 .25rem}
 h2{font-size:1.05rem;margin:2rem 0 .5rem}
 h2 small{font-weight:400;opacity:.7}
 nav{font-size:.9rem;margin-bottom:1.5rem}
 section p{margin:.35rem 0}
 [lang="ar"]{font-size:1.05rem}
 footer{margin-top:3rem;font-size:.85rem;opacity:.75}
</style>
</head>
<body>
<h1>${esc(doc.titleEn)} <span lang="ar" dir="rtl">— ${esc(doc.titleAr)}</span></h1>
<nav>${nav}</nav>
${sections}
<footer>${esc(config.appName)} · ${esc(dateOnly(config.effectiveDate))}</footer>
</body>
</html>`;
}

/** A tiny index so the bare host is not a 404 for a store reviewer. */
export function renderLegalIndex(config: LegalConfig): string {
  const links = allDocs(config)
    .map((d) => `<li><a href="/legal/${d.slug}">${d.titleEn} <span lang="ar" dir="rtl">/ ${d.titleAr}</span></a></li>`)
    .join('\n');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${config.appName} — Privacy &amp; Terms</title></head>
<body><h1>${config.appName}</h1><ul>${links}</ul></body></html>`;
}
