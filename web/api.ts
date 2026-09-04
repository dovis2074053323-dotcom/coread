const BASE = window.location.origin;
const MOUNT_PATH = (window as any).__COREAD_BASE_PATH__
  || (window.location.pathname === '/coread' || window.location.pathname.startsWith('/coread/') ? '/coread' : '');

export const coreadPath = (path: string) => `${MOUNT_PATH}${path}`;

// 共读室关门锁 owner key（task-1786030476040-meb33p）：与 app 端同 key，锁定期彤宝的 web 端照常放行
const ROOM_OWNER_KEY = 'xk-room-owner-f47ac10b58d2e619a3c4';

async function request(path: string, opts?: RequestInit) {
  const res = await fetch(`${BASE}${coreadPath(path)}`, {
    headers: { 'Content-Type': 'application/json', 'x-owner-key': ROOM_OWNER_KEY, 'x-morrow-request': '1' },
    ...opts,
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

export const api = {
  fetchBooks: () => request('/v1/books'),
  fetchBookDetail: (bookId: number, page = 1) =>
    // 统一坐标制：服务端固定分页（BOOK_PER_PAGE），不再传 per_page
    request(`/v1/books/${bookId}?page=${page}`),
  fetchBookSlice: (bookId: number, start = 0, count = 30) =>
    request(`/v1/books/${bookId}/slice?start=${start}&count=${count}`),
  addBookComment: (bookId: number, data: any) =>
    request(`/v1/books/${bookId}/comment`, { method: 'POST', body: JSON.stringify(data) }),
  deleteBookComment: (commentId: number) =>
    request(`/v1/books/comment/${commentId}`, { method: 'DELETE' }),
  updateBookProgress: (bookId: number, page: number, charOffset = 0, requestOptions: RequestInit = {}) =>
    request(`/v1/books/${bookId}/progress`, {
      method: 'PATCH',
      body: JSON.stringify({ page, paragraph_idx: page, char_offset: charOffset }),
      ...requestOptions,
    }),
  createBook: (data: any) =>
    request('/v1/books', { method: 'POST', body: JSON.stringify(data) }),
  deleteBook: (bookId: number) =>
    request(`/v1/books/${bookId}`, { method: 'DELETE' }),
  fetchBookToc: (bookId: number) =>
    request(`/v1/books/${bookId}/toc`),
  exportBook: async (bookId: number, format = 'epub') => {
    const res = await fetch(`${BASE}${coreadPath(`/v1/books/${bookId}/export?format=${format}`)}`, { headers: { 'x-owner-key': ROOM_OWNER_KEY, 'x-morrow-request': '1' } });
    if (!res.ok) throw new Error('Export failed');
    return res.blob();
  },
  imageUrl: (bookId: number, filename: string) =>
    `${BASE}${coreadPath(`/v1/book-images/${bookId}/${filename}`)}`,
  wishlistUrl: () => `${BASE}/v1/reading-wishlist`,
  fetchSettings: () => request('/v1/settings'),
  updateSettings: (data: { context_chars: number }) =>
    request('/v1/settings', { method: 'PUT', body: JSON.stringify(data) }),
  fetchBookBookmark: (bookId: number) => request(`/v1/books/${bookId}/bookmark`),
  updateBookBookmark: (bookId: number, data: { page: number; paragraph_idx: number; char_offset?: number }) =>
    request(`/v1/books/${bookId}/bookmark`, { method: 'PUT', body: JSON.stringify(data) }),
};
