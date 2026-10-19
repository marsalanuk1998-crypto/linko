#!/usr/bin/env bash
# Manual APK build (no Gradle): aapt2 -> javac -> d8 -> zipalign -> apksigner
set -euo pipefail
cd "$(dirname "$0")"
export JAVA_HOME=${JAVA_HOME:-$HOME/jdk}; export PATH="$JAVA_HOME/bin:$PATH"
SDK=${ANDROID_HOME:-$HOME/android-sdk}
BT=$SDK/build-tools/35.0.0
JAR=$SDK/platforms/android-35/android.jar
VERSION_CODE=${VERSION_CODE:-1}
VERSION_NAME=${VERSION_NAME:-1.0.0}
OUT=${OUT:-/workspace/Linko.apk}
rm -rf build && mkdir -p build/res build/gen build/classes build/dex
# 1. bundle the web app
rm -rf assets && mkdir -p assets/web && cp -r ../web/. assets/web/
# 2. resources
$BT/aapt2 compile --dir res -o build/res/res.zip
$BT/aapt2 link -o build/unsigned.apk -I "$JAR" --manifest AndroidManifest.xml \
  --min-sdk-version 24 --target-sdk-version 34 \
  --version-code "$VERSION_CODE" --version-name "$VERSION_NAME" \
  ${DEBUG:+--debug-mode} -0 gz -0 woff2 -0 png -0 jpg \
  -A assets --java build/gen --auto-add-overlay build/res/res.zip
# 3. compile java
javac -nowarn -Xlint:-options -source 8 -target 8 -bootclasspath "$JAR" -d build/classes \
  build/gen/pk/zaib/linko/R.java src/pk/zaib/linko/*.java
# 4. dex
$BT/d8 --release --min-api 24 --lib "$JAR" --output build/dex $(find build/classes -name '*.class')
python3 -c "import zipfile;z=zipfile.ZipFile('build/unsigned.apk','a',zipfile.ZIP_DEFLATED);z.write('build/dex/classes.dex','classes.dex');z.close()"
# 5. align + sign
$BT/zipalign -f -p 4 build/unsigned.apk build/aligned.apk
source ./keystore.env
$BT/apksigner sign --ks linko-release.jks --ks-key-alias "$KS_ALIAS" \
  --ks-pass env:KS_PASS --key-pass env:KS_PASS \
  --v1-signing-enabled true --v2-signing-enabled true --v3-signing-enabled true \
  --out "$OUT" build/aligned.apk
rm -f "$OUT.idsig"
echo "Built $OUT"
