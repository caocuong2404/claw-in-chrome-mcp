import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  buildNativeHostManifest,
  installNativeHost,
} from '../src/nativeHostInstall.js'
import { NATIVE_HOST_IDENTIFIER, NATIVE_HOST_MANIFEST_NAME } from '../src/browser.js'

test('installNativeHost writes wrapper and manifest payload', async () => {
  const tempRoot = await import('node:fs/promises').then(fs =>
    fs.mkdtemp(join(tmpdir(), 'claw-in-chrome-mcp-install-')),
  )
  const wrapperDir = join(tempRoot, 'bin')
  const manifestDir = join(tempRoot, 'manifest')
  const registryCalls: Array<{ browser: string; key: string; manifestPath: string }> = []

  const result = await installNativeHost({
    cliEntryPath: 'C:/tool/dist/cli.js',
    wrapperDirOverride: wrapperDir,
    ...(process.platform === 'win32'
      ? {
          manifestDirOverride: manifestDir,
          registryKeysOverride: [
            {
              browser: 'chrome',
              key: 'HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts',
            },
          ],
          registerWindowsKey: async (browser, key, manifestPath) => {
            registryCalls.push({ browser, key, manifestPath })
            return true
          },
        }
      : {
          manifestDirsOverride: [{ browser: 'chrome', path: manifestDir }],
        }),
  })

  const wrapperContent = await readFile(result.wrapperPath, 'utf8')
  assert.match(wrapperContent, /chrome-native-host/)

  const manifestPath = join(manifestDir, NATIVE_HOST_MANIFEST_NAME)
  const manifestContent = await readFile(manifestPath, 'utf8')
  assert.match(manifestContent, new RegExp(NATIVE_HOST_IDENTIFIER))
  assert.equal(buildNativeHostManifest(result.wrapperPath), manifestContent)

  if (process.platform === 'win32') {
    assert.equal(registryCalls.length, 1)
    assert.equal(result.registryEntries.length, 1)
  } else {
    assert.equal(result.registryEntries.length, 0)
  }
})
