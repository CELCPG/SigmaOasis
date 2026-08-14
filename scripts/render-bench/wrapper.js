// Launches the built app against a throwaway profile.
//
// Never measure against the real profile: the benchmark writes conversations
// and settings, and a run should not be able to touch anything the user cares
// about.
const { app } = require('electron')
const path = require('path')

const profile = process.env.BENCH_PROFILE
if (!profile) {
  console.error('wrapper: BENCH_PROFILE is required')
  process.exit(1)
}
app.setPath('userData', profile)

// macOS throttles an occluded renderer, and a throttled renderer is exactly
// what this benchmark must not measure — an obscured window turns a smooth
// stream into one jump every several seconds and the numbers become fiction.
app.on('browser-window-created', (_e, win) => {
  win.setAlwaysOnTop(true)
})

require(path.join(__dirname, '../../out/main/index.js'))
