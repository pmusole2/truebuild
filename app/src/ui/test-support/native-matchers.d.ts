import type { JestNativeMatchers } from '@testing-library/react-native/dist/matchers/types'

// Jest 30 defines imported expect matchers in `expect`; RNTL 14 augments its
// @jest/expect re-export instead. Use RNTL's exact matcher signatures for the
// owning module too, so imported and global expect share the runtime matchers.
declare module 'expect' {
    // Same generic list as Jest; RNTL supplies all members.
    // eslint-disable-next-line @typescript-eslint/no-empty-object-type, @typescript-eslint/no-unused-vars
    interface Matchers<R extends void | Promise<void>, T = unknown> extends JestNativeMatchers<R> {}
}
