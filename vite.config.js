import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => {
  const isDist = process.env.ELECTRON_DIST === "1";
  return {
    plugins: [react()],
    base: "./",
    // Use the FULL hls.js build (not hls.light). Collaps HLS streams carry the
    // Russian dubs as alternate audio renditions (#EXT-X-MEDIA AUDIO groups), and
    // hls.light does NOT include alternate-audio support — so the light build
    // played video-only (no Russian dub) for any content that falls back to HLS
    // (e.g. movies for which Collaps no longer ships a DASH URL). The full build
    // is larger, but it's a dynamically-imported chunk (loaded only when HLS is
    // actually used) and is what makes the Russian dubs work on the HLS path.
    resolve: {
      alias: {
        "hls.js": "hls.js/dist/hls.mjs",
      },
    },
    build: {
      minify: "terser",
      terserOptions: {
        compress: {
          drop_console: isDist,
          drop_debugger: isDist,
        },
      },
      rollupOptions: {
        output: {
          manualChunks: {
            react: ["react", "react-dom"],
            settings: ["./src/pages/SettingsPage"],
            movie: ["./src/pages/MoviePage"],
            tv: ["./src/pages/TVPage"],
            downloads: ["./src/pages/DownloadsPage"],
            discover: ["./src/pages/DiscoverPage"],
            together: ["./src/pages/WatchTogetherPage"],
          },
        },
      },
    },
  };
});
