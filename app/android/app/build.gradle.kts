plugins {
    id("com.android.application")
    id("kotlin-android")
    // The Flutter Gradle Plugin must be applied after the Android and Kotlin Gradle plugins.
    id("dev.flutter.flutter-gradle-plugin")
}

val configuredApplicationId = System.getenv("ANDROID_APPLICATION_ID")
    ?.takeIf { it.isNotBlank() }
    ?: "com.placeholder.saudi_english_tutor"
val releaseSigningValues = mapOf(
    "ANDROID_KEYSTORE_PATH" to System.getenv("ANDROID_KEYSTORE_PATH"),
    "ANDROID_KEYSTORE_PASSWORD" to System.getenv("ANDROID_KEYSTORE_PASSWORD"),
    "ANDROID_KEY_ALIAS" to System.getenv("ANDROID_KEY_ALIAS"),
    "ANDROID_KEY_PASSWORD" to System.getenv("ANDROID_KEY_PASSWORD"),
)
val releaseSigningConfigured = releaseSigningValues.values.all { !it.isNullOrBlank() }

android {
    namespace = "com.placeholder.saudi_english_tutor"
    compileSdk = flutter.compileSdkVersion
    ndkVersion = flutter.ndkVersion

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = JavaVersion.VERSION_17.toString()
    }

    defaultConfig {
        // Override for release builds after the product owner chooses the permanent
        // Play Store identity. The release task rejects this placeholder.
        applicationId = configuredApplicationId
        // You can update the following values to match your application needs.
        // For more information, see: https://flutter.dev/to/review-gradle-config.
        minSdk = flutter.minSdkVersion
        targetSdk = flutter.targetSdkVersion
        versionCode = flutter.versionCode
        versionName = flutter.versionName
    }

    if (releaseSigningConfigured) {
        signingConfigs {
            create("release") {
                storeFile = file(requireNotNull(releaseSigningValues["ANDROID_KEYSTORE_PATH"]))
                storePassword = requireNotNull(releaseSigningValues["ANDROID_KEYSTORE_PASSWORD"])
                keyAlias = requireNotNull(releaseSigningValues["ANDROID_KEY_ALIAS"])
                keyPassword = requireNotNull(releaseSigningValues["ANDROID_KEY_PASSWORD"])
            }
        }
    }

    buildTypes {
        release {
            if (releaseSigningConfigured) {
                signingConfig = signingConfigs.getByName("release")
            }
        }
    }
}

tasks.configureEach {
    if (name == "assembleRelease" || name == "bundleRelease" || name == "packageRelease") {
        doFirst {
            if (!releaseSigningConfigured || configuredApplicationId.startsWith("com.placeholder.")) {
                throw GradleException(
                    "Release requires ANDROID_APPLICATION_ID and all four ANDROID_KEYSTORE/KEY credentials; " +
                        "debug signing is intentionally disabled."
                )
            }
        }
    }
}

flutter {
    source = "../.."
}
