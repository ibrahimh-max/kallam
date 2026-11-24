import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../state/providers.dart';
import '../../theme/tokens.dart';
import '../../ui/widgets.dart';

/// Profile and settings.
///
/// Everything a learner must be able to control lives here: their name, their
/// level and daily goal, their voice consent (granted *and* withdrawn), and the
/// two irreversible actions — sign out and delete the account. Deletion is behind
/// an explicit confirmation that spells out the grace period, because a mis-tap
/// must not be able to start it.
class ProfileScreen extends ConsumerStatefulWidget {
  const ProfileScreen({super.key});

  @override
  ConsumerState<ProfileScreen> createState() => _ProfileScreenState();
}

class _ProfileScreenState extends ConsumerState<ProfileScreen> {
  late final TextEditingController _name;
  bool _savingName = false;
  bool _deleting = false;
  bool _busyConsent = false;
  String? _error;
  String? _notice;

  static const _levelLabels = <String, String>{
    'complete_beginner': 'مبتدئ تماماً',
    'few_words': 'أعرف كلمات بسيطة',
    'simple_understanding': 'أفهم إنجليزي بسيط',
    'basic_conversation': 'أقدر أسوي محادثة بسيطة',
  };

  static const _goalLabels = <String, String>{
    'everyday': 'محادثات يومية',
    'work': 'العمل والوظيفة',
    'travel': 'السفر',
    'study': 'الدراسة',
    'general': 'إنجليزي عام',
  };

  @override
  void initState() {
    super.initState();
    _name = TextEditingController(
      text: ref.read(authControllerProvider).profile?.displayName ?? '',
    );
  }

  @override
  void dispose() {
    _name.dispose();
    super.dispose();
  }

  Future<void> _saveName() async {
    final name = _name.text.trim();
    setState(() {
      _savingName = true;
      _error = null;
      _notice = null;
    });
    try {
      await ref.read(authControllerProvider.notifier).updateDisplayName(name.isEmpty ? null : name);
      if (!mounted) return;
      setState(() => _notice = 'حفظنا اسمك.');
    } on Object catch (error) {
      if (!mounted) return;
      setState(() => _error = userMessageFor(error));
    } finally {
      if (mounted) setState(() => _savingName = false);
    }
  }

  Future<void> _updateGoal(int minutes) async {
    setState(() {
      _error = null;
      _notice = null;
    });
    try {
      await ref.read(authControllerProvider.notifier).updateDailyGoal(minutes);
      if (!mounted) return;
      setState(() => _notice = 'حدّثنا هدفك اليومي إلى $minutes دقائق.');
    } on Object catch (error) {
      if (!mounted) return;
      setState(() => _error = userMessageFor(error));
    }
  }

  Future<void> _setConsent(bool granted) async {
    setState(() {
      _busyConsent = true;
      _error = null;
      _notice = null;
    });
    try {
      final auth = ref.read(authControllerProvider.notifier);
      if (granted) {
        await auth.grantVoiceConsent();
      } else {
        await auth.withdrawVoiceConsent();
      }
      if (!mounted) return;
      setState(() => _notice = granted ? 'فعّلنا الموافقة على الصوت.' : 'سحبنا موافقتك. لن نسجل صوتك.');
    } on Object catch (error) {
      if (!mounted) return;
      setState(() => _error = userMessageFor(error));
    } finally {
      if (mounted) setState(() => _busyConsent = false);
    }
  }

  Future<void> _signOut() async {
    await ref.read(authControllerProvider.notifier).signOut();
    if (mounted) Navigator.of(context).popUntil((route) => route.isFirst);
  }

  Future<void> _confirmDelete() async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: const Text('تحذف حسابك؟'),
        content: const Text(
          'راح تتقفل جلستك الحين، ونمسح بياناتك ودروسك من سجلاتنا بعد ٣٠ يوم. '
          'تقدر ترجع خلال هذي المدة بتواصل معنا، وبعدها ما نقدر نسترجع شي.',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(dialogContext).pop(false),
            child: const Text('إلغاء'),
          ),
          FilledButton(
            style: FilledButton.styleFrom(backgroundColor: AppColors.danger),
            onPressed: () => Navigator.of(dialogContext).pop(true),
            child: const Text('احذف حسابي'),
          ),
        ],
      ),
    );
    if (confirmed != true || !mounted) return;

    setState(() {
      _deleting = true;
      _error = null;
    });
    try {
      await ref.read(authControllerProvider.notifier).deleteAccount();
      if (mounted) Navigator.of(context).popUntil((route) => route.isFirst);
    } on Object catch (error) {
      if (!mounted) return;
      setState(() {
        _deleting = false;
        _error = userMessageFor(error);
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final auth = ref.watch(authControllerProvider);
    final profile = auth.profile;
    if (profile == null) {
      // Signing out while this screen is open is legitimate; the router takes over.
      return const Scaffold(body: LoadingState());
    }
    final usage = ref.watch(usageProvider);

    return Scaffold(
      appBar: AppBar(title: const Text('الإعدادات')),
      body: ListView(
        padding: const EdgeInsets.fromLTRB(AppSpace.xl, AppSpace.lg, AppSpace.xl, AppSpace.xxl),
        children: [
          if (_error != null) ...[
            AppCard(
              color: AppColors.dangerSoft,
              borderColor: AppColors.danger,
              child: Text(_error!, style: AppType.body.copyWith(color: AppColors.danger)),
            ),
            const SizedBox(height: AppSpace.lg),
          ],
          if (_notice != null) ...[
            AppCard(
              color: AppColors.successSoft,
              borderColor: AppColors.success,
              child: Text(_notice!, style: AppType.body.copyWith(color: AppColors.success)),
            ),
            const SizedBox(height: AppSpace.lg),
          ],

          const SectionTitle('ملفي'),
          const SizedBox(height: AppSpace.md),
          AppCard(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                TextField(
                  controller: _name,
                  maxLength: 60,
                  textInputAction: TextInputAction.done,
                  decoration: const InputDecoration(labelText: 'اسمك', counterText: ''),
                ),
                const SizedBox(height: AppSpace.md),
                PrimaryButton(
                  label: 'احفظ الاسم',
                  busyLabel: 'نحفظ…',
                  onPressed: _savingName ? null : _saveName,
                ),
                const SizedBox(height: AppSpace.lg),
                _ReadOnlyRow(
                  label: 'مستواك',
                  value: _levelLabels[profile.englishLevel] ?? 'غير محدد',
                ),
                const SizedBox(height: AppSpace.sm),
                _ReadOnlyRow(
                  label: 'هدفك',
                  value: _goalLabels[profile.learningGoal] ?? 'غير محدد',
                ),
              ],
            ),
          ),

          const SizedBox(height: AppSpace.xl),
          const SectionTitle('هدفك اليومي'),
          const SizedBox(height: AppSpace.md),
          AppCard(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Text(
                  'اختر الوقت اللي تقدر تلتزم فيه فعلاً.',
                  style: AppType.body.copyWith(color: AppColors.textMuted),
                ),
                const SizedBox(height: AppSpace.md),
                Row(
                  children: [
                    for (final minutes in const [5, 10, 15])
                      Expanded(
                        child: Padding(
                          padding: const EdgeInsetsDirectional.only(end: AppSpace.sm),
                          child: OutlinedButton(
                            onPressed: profile.dailyGoalMinutes == minutes
                                ? null
                                : () => _updateGoal(minutes),
                            style: OutlinedButton.styleFrom(
                              minimumSize: const Size.fromHeight(kMinTouchTarget),
                            ),
                            child: Text('$minutes دقيقة'),
                          ),
                        ),
                      ),
                  ],
                ),
              ],
            ),
          ),

          const SizedBox(height: AppSpace.xl),
          const SectionTitle('الخصوصية والصوت'),
          const SizedBox(height: AppSpace.md),
          AppCard(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  'نسجّل صوتك وقت تمارين الكلام فقط، ونرسله لتحويل الكلام إلى نص. '
                  'ما نحفظ التسجيل بعد انتهاء المحاولة.',
                  style: AppType.body.copyWith(color: AppColors.textMuted),
                ),
                const SizedBox(height: AppSpace.lg),
                SwitchListTile(
                  value: profile.voiceConsentGranted,
                  onChanged: _busyConsent ? null : _setConsent,
                  contentPadding: EdgeInsets.zero,
                  title: Text('موافقتك على معالجة الصوت', style: AppType.label),
                  subtitle: Text(
                    profile.voiceConsentGranted
                        ? 'مفعّلة — تمارين الكلام شغالة.'
                        : 'موقوفة — تمارين الكلام موقوفة، وتقدر تكتب بدالها.',
                    style: AppType.caption.copyWith(color: AppColors.textMuted),
                  ),
                ),
              ],
            ),
          ),

          const SizedBox(height: AppSpace.xl),
          const SectionTitle('استخدامك'),
          const SizedBox(height: AppSpace.md),
          usage.when(
            loading: () => const SizedBox(height: 80, child: LoadingState()),
            error: (error, _) => AppCard(
              child: Text(userMessageFor(error), style: AppType.body.copyWith(color: AppColors.textMuted)),
            ),
            data: (data) => AppCard(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  _ReadOnlyRow(
                    label: 'تمارين الكلام اليوم',
                    value: '${data.speakingUsed} من ${data.speakingLimit}',
                  ),
                  const SizedBox(height: AppSpace.sm),
                  _ReadOnlyRow(
                    label: 'جمل مسموعة من الكاش',
                    value: '${data.ttsCacheHitsToday}',
                  ),
                ],
              ),
            ),
          ),

          const SizedBox(height: AppSpace.xl),
          const SectionTitle('الحساب'),
          const SizedBox(height: AppSpace.md),
          AppCard(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                OutlinedButton(
                  onPressed: _signOut,
                  style: OutlinedButton.styleFrom(minimumSize: const Size.fromHeight(kMinTouchTarget)),
                  child: const Text('تسجيل الخروج'),
                ),
                const SizedBox(height: AppSpace.md),
                OutlinedButton(
                  onPressed: _deleting ? null : _confirmDelete,
                  style: OutlinedButton.styleFrom(
                    minimumSize: const Size.fromHeight(kMinTouchTarget),
                    foregroundColor: AppColors.danger,
                    side: const BorderSide(color: AppColors.danger),
                  ),
                  child: Text(_deleting ? 'نحذف…' : 'حذف الحساب نهائياً'),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _ReadOnlyRow extends StatelessWidget {
  const _ReadOnlyRow({required this.label, required this.value});

  final String label;
  final String value;

  @override
  Widget build(BuildContext context) {
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Expanded(child: Text(label, style: AppType.body.copyWith(color: AppColors.textMuted))),
        const SizedBox(width: AppSpace.md),
        Flexible(child: Text(value, style: AppType.label, textAlign: TextAlign.end)),
      ],
    );
  }
}
