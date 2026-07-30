import { spawn, type ChildProcess } from 'node:child_process'

// Holds a macOS power assertion (display + idle sleep) while at least one turn is running,
// so an unattended agent isn't interrupted by display sleep / lock.
// `-w <our pid>` makes the kernel drop the assertion if we die without cleaning up
// (SIGKILL, crash): an orphaned caffeinate can never keep the machine awake forever.
let proc: ChildProcess | null = null
let holds = 0

export function stayAwake(): () => void {
  holds++
  // Spawn whenever we have no live assertion, not only on the 0->1 hold: a failed spawn or a
  // caffeinate that died on its own then self-heals on the next turn instead of staying lost.
  if (!proc && process.platform === 'darwin') {
    try {
      const child = spawn('caffeinate', ['-dims', '-w', String(process.pid)], { stdio: 'ignore' })
      const forget = () => {
        if (proc === child) proc = null
      }
      child.on('error', forget)
      child.on('exit', forget)
      child.unref()
      proc = child
    } catch {
      proc = null
    }
  }

  let released = false
  return () => {
    if (released) return
    released = true
    if (--holds === 0) {
      proc?.kill()
      proc = null
    }
  }
}

export function stayAwakeHolds(): number {
  return holds
}
