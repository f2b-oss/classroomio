#!/bin/sh
# Configures the FFmpeg build used by the jobs image. Run from the FFmpeg source
# directory; extra arguments are passed through to ./configure.
#
# The jobs worker runs ffprobe and ffmpeg on user-uploaded media, so the build
# contains only what apps/jobs/src/processors/media needs for the upload formats
# accepted in packages/utils/src/validation (mp4, mov, mkv, webm):
#   probe-metadata      ffprobe on the uploaded file
#   generate-thumbnail  one scaled frame to JPEG, then signalstats on that JPEG
#   extract-audio       16 kHz mono MP3 from the upload or from an HLS rendition
# The HLS input is the encoder's own output (MPEG-TS segments, H.264 and AAC).
set -eu

exec ./configure \
  --disable-everything \
  --disable-network \
  --disable-autodetect \
  --disable-doc \
  --disable-debug \
  --disable-ffplay \
  --disable-avdevice \
  --enable-zlib \
  --enable-libdav1d \
  --enable-libmp3lame \
  --enable-protocol=file \
  --enable-demuxer=mov,matroska,mpegts,hls,mp3,aac,wav,image2 \
  --enable-decoder=h264,hevc,vp8,vp9,libdav1d,aac,mp3,opus,vorbis,pcm_s16le,pcm_f32le,mjpeg,png \
  --enable-parser=h264,hevc,vp9,av1,aac,mpegaudio \
  --enable-encoder=mjpeg,libmp3lame,wrapped_avframe \
  --enable-muxer=mp3,image2,null \
  --enable-filter=scale,signalstats,metadata,format,null,anull,aresample,aformat \
  "$@"
