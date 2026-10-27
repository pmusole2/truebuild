/** Browser-owned blob URLs only. User file/library URIs are never deleted by this adapter. */
export async function removeTemporaryImage(uri: string): Promise<void> {
    if (uri.startsWith('blob:')) {
        URL.revokeObjectURL(uri)
    }
}
