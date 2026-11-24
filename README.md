# Kal'lam

**Understand. Listen. Speak. Improve.**

Kal'lam is an AI-powered English learning application initially designed for Saudi Arabic-speaking adults who want to improve their practical English communication skills.

Its learning approach follows a simple cycle:

**Understand in Saudi Arabic → Listen in English → Speak in English → Receive feedback in Saudi Arabic → Practise again.**

## Core Features

- User registration and authentication
- Learner onboarding and profile setup
- Structured English lessons
- Speaking practice and microphone recording
- AI-oriented speaking feedback
- Text-to-speech playback
- Learning progress tracking
- Vocabulary practice
- Email verification and password recovery

## Technology Stack

| Layer | Technology |
|---|---|
| Frontend | Flutter / Dart |
| Backend | Node.js / TypeScript / Express |
| Database | Supabase / PostgreSQL |
| Speech services | HUMAIN Voice API |
| Email | Resend |
| Testing | Flutter, backend and E2E tests |

## Project Structure

```text
kallam/
├── app/
│   ├── lib/
│   ├── test/
│   ├── web/
│   └── android/
├── server/
│   ├── src/
│   └── tests/
├── supabase/
│   └── migrations/
├── docs/
├── tools/
└── README.md
```

## Getting Started

### Requirements

- Flutter SDK
- Node.js and npm
- Git

### Frontend

```powershell
cd app
flutter pub get
flutter run -d chrome
```

Build for web:

```powershell
flutter build web
```

### Backend

```powershell
cd server
npm install
```

Configure the required environment variables using `.env.example`.

### Database

Database migrations and security policies are maintained in `supabase/migrations/`.

A configured Supabase project is required for live database verification.

## Architecture Principles

Kal'lam is developed around three principles:

- **FAST:** Short lessons and quick speaking exercises.
- **CHEAP:** Efficient AI service usage and reusable learning content.
- **SECURE:** Protect user information, credentials and voice data.

## Development Status

**Active development — Not production-ready.**

The Flutter Web application and its primary local user journeys have been tested.

Remaining validation includes:

- Live Supabase integration and migration verification
- Live Resend email delivery
- Real HUMAIN speech recognition and synthesis quality
- Native Android device testing
- Saudi learner and native-speaker validation
- Production security and operational readiness

## Security

Never commit `.env` files, API keys, tokens or signing credentials.

Keep AI provider credentials on the backend. Use local environment files or a secure secret manager.

## License

All rights reserved. No open-source licence has been granted at this stage.