export function findBookById(books, bookId) {
  if (!Number.isInteger(bookId) || bookId < 1 || !Array.isArray(books)) return null;
  return books.find(book => book?.id === bookId) || null;
}
