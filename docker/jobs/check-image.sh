#!/bin/sh
# Checks a built jobs image: non-root user, an FFmpeg with only the local file
# protocol and none of the decoders that have reachable CVEs, and the media
# steps working on the fixtures.
#
#   docker/jobs/check-image.sh <image>
set -eu

image="$1"
here="$(cd "$(dirname "$0")" && pwd)"
failed=0

fail() {
  echo "FAIL $*"
  failed=1
}

run() {
  docker run --rm --network none "$image" "$@"
}

uid="$(run id -u)"
if [ "$uid" = "0" ]; then fail "image runs as root"; else echo "ok   runs as uid $uid"; fi

run ffmpeg -hide_banner -version | head -n 1

protocols="$(run ffmpeg -hide_banner -protocols)"
for p in http https tcp udp rtp rtsp rtmp rist srt tls crypto data concat subfile pipe; do
  if echo "$protocols" | grep -qxE "[[:space:]]*$p"; then fail "protocol $p is built in"; fi
done
echo "     protocols: $(echo "$protocols" | grep -E '^[[:space:]]+[a-z0-9_]+$' | sort -u | tr -d ' ' | tr '\n' ' ')"

decoders="$(run ffmpeg -hide_banner -decoders)"
for d in cfhd magicyuv tdsc adpcm_adx mace6 librsvg rasc dvdsub dvbsub tiff libjxl; do
  if echo "$decoders" | grep -qE "^ [A-Z.]{6} $d( |$)"; then fail "decoder $d is built in"; fi
done
echo "     decoders: $(echo "$decoders" | grep -E '^ [A-Z.]{6} ' | awk '$2 != "=" {print $2}' | tr '\n' ' ')"

demuxers="$(run ffmpeg -hide_banner -demuxers)"
for m in avi concat dash rtsp sdp; do
  if echo "$demuxers" | grep -qE "^ D[ E][ d] +([a-z0-9_]+,)*$m(,| |$)"; then fail "demuxer $m is built in"; fi
done
echo "     demuxers: $(echo "$demuxers" | grep -E '^ D[ E][ d] +[a-z]' | awk '{print $2}' | tr '\n' ' ')"

if run sh -c 'command -v apt-get >/dev/null && dpkg -s ffmpeg' >/dev/null 2>&1; then
  fail "the Debian ffmpeg package is installed"
fi

if ! docker run --rm --network none -v "$here:/check:ro" "$image" \
  node /check/check-media.mjs /app/apps/jobs/dist/utils/ffmpeg.js /check/fixtures; then
  fail "media checks"
fi

exit "$failed"
