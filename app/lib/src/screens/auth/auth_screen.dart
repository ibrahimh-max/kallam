import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../config/app_config.dart';
import '../../data/models.dart';
import '../../state/providers.dart';
import '../../theme/tokens.dart';
import '../../ui/widgets.dart';

/// Sign in / create account, on one screen with a tab-like switch.
///
/// Field-level validation mirrors the server's rules (password >= 8, a real
/// e-mail shape) so the learner is corrected before a round trip, but the server
/// remains the authority: a rejection from it is shown next to the field it names.
class AuthScreen extends ConsumerStatefulWidget {
  const AuthScreen({super.key});

  @override
  ConsumerState<AuthScreen> createState() => _AuthScreenState();
}

class _AuthScreenState extends ConsumerState<AuthScreen> {
  final _formKey = GlobalKey<FormState>();
  final _email = TextEditingController();
  final _password = TextEditingController();
  final _displayName = TextEditingController();

  bool _registering = false;
  bool _emailActionBusy = false;
  bool _obscure = true;
  bool _termsAccepted = false;
  bool _privacyPolicyAccepted = false;
  String? _formError;
  String? _formSuccess;
  String? _errorField;

  @override
  void dispose() {
    _email.dispose();
    _password.dispose();
    _displayName.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    setState(() {
      _formError = null;
      _formSuccess = null;
      _errorField = null;
    });
    if (!(_formKey.currentState?.validate() ?? false)) return;
    if (_registering && (!_termsAccepted || !_privacyPolicyAccepted)) {
      setState(
        () => _formError =
            'وافق على شروط الخدمة وسياسة الخصوصية قبل إنشاء الحساب.',
      );
      return;
    }
    try {
      final auth = ref.read(authControllerProvider.notifier);
      if (_registering) {
        await auth.register(
          email: _email.text.trim(),
          password: _password.text,
          termsAccepted: _termsAccepted,
          privacyPolicyAccepted: _privacyPolicyAccepted,
          displayName: _displayName.text.trim(),
          voiceConsent: false,
        );
        if (!mounted) return;
        setState(() {
          _registering = false;
          _termsAccepted = false;
          _privacyPolicyAccepted = false;
          _formSuccess =
              'أرسلنا رابط التحقق إذا كان البريد متاحاً. أكّد بريدك أولاً، ثم سجّل الدخول.';
        });
        return;
      } else {
        await auth.login(email: _email.text.trim(), password: _password.text);
      }
      // Navigation is driven by authControllerProvider state, not a push here.
    } on Object catch (error) {
      if (!mounted) return;
      setState(() {
        _formError = userMessageFor(error);
        _errorField = error is ApiError ? error.field : null;
      });
    }
  }

  Future<void> _sendEmailAction({required bool recovery}) async {
    setState(() {
      _formError = null;
      _formSuccess = null;
      _errorField = null;
    });
    final email = _email.text.trim();
    if (!RegExp(r'^[^\s@]+@[^\s@]+\.[^\s@]+$').hasMatch(email)) {
      setState(() => _formError = 'اكتب بريدك الإلكتروني بصيغة صحيحة.');
      return;
    }

    setState(() => _emailActionBusy = true);
    try {
      final auth = ref.read(authControllerProvider.notifier);
      if (recovery) {
        await auth.requestPasswordRecovery(email: email);
      } else {
        await auth.resendVerification(email: email);
      }
      if (!mounted) return;
      setState(() {
        _formSuccess = recovery
            ? 'إذا كان للحساب بريد مؤكد، بنرسل رابط استعادة كلمة المرور.'
            : 'إذا كان البريد يحتاج تحقق، بنرسل رسالة جديدة.';
      });
    } on Object catch (error) {
      if (!mounted) return;
      setState(() {
        _formError = userMessageFor(error);
        _errorField = error is ApiError ? error.field : null;
      });
    } finally {
      if (mounted) setState(() => _emailActionBusy = false);
    }
  }

  Future<void> _openLegalPage(String slug) async {
    final uri = Uri.parse('${AppConfig.apiBaseUrl}/legal/$slug');
    try {
      final opened = await launchUrl(uri, mode: LaunchMode.externalApplication);
      if (!opened && mounted) {
        setState(
          () => _formError = 'ما قدرنا نفتح الصفحة. تقدر المحاولة بعدين.',
        );
      }
    } on Object catch (error) {
      if (mounted) setState(() => _formError = userMessageFor(error));
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.all(AppSpace.xl),
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 460),
              child: Form(
                key: _formKey,
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    // Signature element: the app's name in Arabic, with the one-line
                    // promise underneath. No hero illustration, no feature cards.
                    Text(
                      'معلّمك للإنجليزي',
                      style: AppType.display,
                      textAlign: TextAlign.center,
                    ),
                    const SizedBox(height: AppSpace.sm),
                    Text(
                      'نتكلم عربي، ونتعلم إنجليزي خطوة خطوة.',
                      textAlign: TextAlign.center,
                      style: AppType.body.copyWith(color: AppColors.textMuted),
                    ),
                    const SizedBox(height: AppSpace.xxl),

                    if (_registering) ...[
                      TextFormField(
                        controller: _displayName,
                        textInputAction: TextInputAction.next,
                        maxLength: 60,
                        decoration: const InputDecoration(
                          labelText: 'اسمك (اختياري)',
                          counterText: '',
                        ),
                      ),
                      const SizedBox(height: AppSpace.lg),
                    ],

                    TextFormField(
                      controller: _email,
                      keyboardType: TextInputType.emailAddress,
                      textInputAction: TextInputAction.next,
                      autocorrect: false,
                      autofillHints: const [AutofillHints.email],
                      decoration: InputDecoration(
                        labelText: 'البريد الإلكتروني',
                        errorText: _errorField == 'email' ? _formError : null,
                      ),
                      validator: (value) {
                        final text = value?.trim() ?? '';
                        if (text.isEmpty) return 'اكتب بريدك الإلكتروني.';
                        if (!RegExp(
                          r'^[^\s@]+@[^\s@]+\.[^\s@]+$',
                        ).hasMatch(text)) {
                          return 'صيغة البريد غير صحيحة.';
                        }
                        return null;
                      },
                    ),
                    const SizedBox(height: AppSpace.lg),

                    TextFormField(
                      controller: _password,
                      obscureText: _obscure,
                      textInputAction: TextInputAction.done,
                      autofillHints: _registering
                          ? const [AutofillHints.newPassword]
                          : const [AutofillHints.password],
                      onFieldSubmitted: (_) => _submit(),
                      decoration: InputDecoration(
                        labelText: 'كلمة المرور',
                        errorText: _errorField == 'password'
                            ? _formError
                            : null,
                        suffixIcon: IconButton(
                          // A learner must be able to check what they typed.
                          icon: Icon(
                            _obscure
                                ? Icons.visibility_outlined
                                : Icons.visibility_off_outlined,
                          ),
                          tooltip: _obscure
                              ? 'إظهار كلمة المرور'
                              : 'إخفاء كلمة المرور',
                          onPressed: () => setState(() => _obscure = !_obscure),
                        ),
                      ),
                      validator: (value) {
                        final text = value ?? '';
                        if (text.isEmpty) return 'اكتب كلمة المرور.';
                        if (_registering && text.length < 8) {
                          return 'كلمة المرور 8 أحرف على الأقل.';
                        }
                        return null;
                      },
                    ),

                    if (_registering) ...[
                      const SizedBox(height: AppSpace.lg),
                      AppCard(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.stretch,
                          children: [
                            CheckboxListTile(
                              contentPadding: EdgeInsets.zero,
                              controlAffinity: ListTileControlAffinity.leading,
                              value: _termsAccepted,
                              onChanged: (value) => setState(() {
                                _termsAccepted = value ?? false;
                                _formError = null;
                              }),
                              title: Text(
                                'أوافق على شروط الخدمة',
                                style: AppType.label,
                              ),
                            ),
                            Align(
                              alignment: AlignmentDirectional.centerStart,
                              child: TextButton(
                                onPressed: () => _openLegalPage('terms'),
                                child: const Text('اقرأ شروط الخدمة'),
                              ),
                            ),
                            const Divider(),
                            CheckboxListTile(
                              contentPadding: EdgeInsets.zero,
                              controlAffinity: ListTileControlAffinity.leading,
                              value: _privacyPolicyAccepted,
                              onChanged: (value) => setState(() {
                                _privacyPolicyAccepted = value ?? false;
                                _formError = null;
                              }),
                              title: Text(
                                'أوافق على سياسة الخصوصية',
                                style: AppType.label,
                              ),
                            ),
                            Align(
                              alignment: AlignmentDirectional.centerStart,
                              child: TextButton(
                                onPressed: () => _openLegalPage('privacy'),
                                child: const Text('اقرأ سياسة الخصوصية'),
                              ),
                            ),
                          ],
                        ),
                      ),
                    ],

                    if (_formError != null && _errorField == null) ...[
                      const SizedBox(height: AppSpace.lg),
                      AppCard(
                        color: AppColors.dangerSoft,
                        borderColor: AppColors.danger,
                        child: Row(
                          children: [
                            const Icon(
                              Icons.error_outline,
                              size: 18,
                              color: AppColors.danger,
                            ),
                            const SizedBox(width: AppSpace.sm),
                            Expanded(
                              child: Text(
                                _formError!,
                                style: AppType.body.copyWith(
                                  color: AppColors.danger,
                                ),
                              ),
                            ),
                          ],
                        ),
                      ),
                    ],

                    if (_formSuccess != null) ...[
                      const SizedBox(height: AppSpace.lg),
                      AppCard(child: Text(_formSuccess!, style: AppType.body)),
                    ],

                    const SizedBox(height: AppSpace.xl),
                    PrimaryButton(
                      label: _registering ? 'أنشئ حسابي' : 'تسجيل الدخول',
                      busyLabel: 'لحظة…',
                      onPressed: _submit,
                    ),
                    const SizedBox(height: AppSpace.md),
                    TextButton(
                      onPressed: () => setState(() {
                        _registering = !_registering;
                        _termsAccepted = false;
                        _privacyPolicyAccepted = false;
                        _formError = null;
                        _formSuccess = null;
                        _errorField = null;
                      }),
                      child: Text(
                        _registering
                            ? 'عندي حساب بالفعل — دخول'
                            : 'ما عندي حساب — أنشئ حساب جديد',
                      ),
                    ),
                    if (!_registering) ...[
                      TextButton(
                        onPressed: _emailActionBusy
                            ? null
                            : () => _sendEmailAction(recovery: false),
                        child: const Text('إعادة إرسال رسالة التحقق'),
                      ),
                      TextButton(
                        onPressed: _emailActionBusy
                            ? null
                            : () => _sendEmailAction(recovery: true),
                        child: const Text('نسيت كلمة المرور؟'),
                      ),
                    ],
                    if (_emailActionBusy)
                      const Padding(
                        padding: EdgeInsets.only(top: AppSpace.sm),
                        child: Center(child: CircularProgressIndicator()),
                      ),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}
