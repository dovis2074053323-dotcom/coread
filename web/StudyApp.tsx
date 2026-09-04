
import React, { useState, useEffect, useCallback, useRef, startTransition, useLayoutEffect, useMemo } from 'react';
import { api, coreadPath } from './api';

// Morrow 暖纸主题：对齐 morrow/web tokens.css（--bg #f8f8f6 / --text #3d3929 /
// --line #ebe7e1 / --action #bd5d3a / 衬线正文）。iframe 拿不到宿主的 CSS 变量，
// 值写死在这里。参数保留只为兼容旧调用签名，实际忽略。
function themeColors(_h?: number, _s?: number, _l?: number) {
    const ink = '#3d3929';
    const inkSoft = '#6b665e';
    const muted = '#9a958b';
    return {
        primary: '#bd5d3a',
        primaryLight: '#efe9e1',
        primaryBg: '#f3efe8',
        primaryBorder: 'rgba(61,57,41,0.10)',
        primaryDark: ink,
        warmAccent: '#c89a5d',
        warmBg: '#efe7d9',
        grad1: '#f5f2ec',
        grad2: '#f3efe8',
        grad3: '#f6f3ed',
        // 神＝Resident（AI），彤＝用户。两种「笔迹」：Resident 用赭石暖色（与正文同色系，
        // 像作者本人的手记），用户用安静的青灰（客座读者的旁批）。一眼可分，都不是聊天气泡。
        shenColor: '#a8543a',
        shenBg: 'rgba(189,93,58,0.09)',
        tongColor: '#4f6b74',
        tongBg: 'rgba(79,107,116,0.09)',
        shenHL: 'rgba(189,93,58,0.17)',
        tongHL: 'rgba(79,107,116,0.16)',
        ink, inkSoft, muted,
    };
}

interface Book {
    id: number;
    title: string;
    total_paragraphs: number;
    created_at: string;
    cover_image?: string | null;
    current_page: number | null;
    last_read_at?: string | null;
    current_offset?: number | null;
    bookmark_page?: number | null;
    bookmark_paragraph_idx?: number | null;
    bookmark_offset?: number | null;
    bookmark_updated_at?: string | null;
    comment_count: number;
}
interface Paragraph { idx: number; content: string; }
interface Comment { id: number; book_id: number; paragraph_idx: number; sel_end_para_idx: number | null; sel_start_idx: number | null; sel_end_idx: number | null; selected_text: string | null; from_who: string; content: string; created_at: string; reply_to: number | null; }
interface Bookmark { page: number; paragraph_idx: number; char_offset: number; created_at?: string | null; updated_at?: string | null; }
interface PageBreak { paraIndex: number; offset: number; }
interface PageFragment extends Paragraph { sourceIdx: number; startOffset: number; endOffset: number; isPartialStart: boolean; isPartialEnd: boolean; }
interface CoreadBinding {
    sessionId: string | null;
    valid: boolean;
    reason: string | null;
    session: { id: string; title: string; lastActivityAt: number } | null;
}
interface BindingCandidate { id: string; title: string; lastActivityAt: number; }
interface ReplyNotice {
    id: number;
    paragraph_idx: number;
    content: string;
    from_who?: string;
    created_at?: string;
    reply_to?: number | null;
    parent_id?: number | null;
    parent_from?: string;
    parent_content?: string;
    sel_start_idx?: number | null;
    sel_end_idx?: number | null;
    selected_text?: string | null;
    parent_paragraph_idx?: number | null;
    parent_sel_start_idx?: number | null;
    parent_sel_end_idx?: number | null;
    parent_selected_text?: string | null;
}

const BOOK_COVERS = [
    'linear-gradient(145deg, rgba(204,209,231,0.86), rgba(244,246,250,0.76))',
    'linear-gradient(145deg, rgba(231,201,213,0.86), rgba(250,244,247,0.76))',
    'linear-gradient(145deg, rgba(199,221,225,0.86), rgba(246,250,250,0.76))',
    'linear-gradient(145deg, rgba(214,225,207,0.86), rgba(248,250,245,0.76))',
    'linear-gradient(145deg, rgba(232,216,192,0.86), rgba(251,248,242,0.76))',
    'linear-gradient(145deg, rgba(212,203,230,0.86), rgba(248,246,251,0.76))',
];

// 暖纸阅读面。正文永远是绝对主体——低信息密度、安静、无阴影（对齐 Morrow 铁律）。
const PAPER_BG = '#f7f4ee';
const PAPER_BG_NIGHT = '#1f1e1b';
const READER_INK = '#3d3929';
const READER_INK_SOFT = '#4a453c';
const READER_INK_NIGHT = '#dcd5c9';
const READER_INK_NIGHT_SOFT = '#b6aea2';
const READER_SERIF = "Georgia, 'Songti SC', 'Noto Serif CJK SC', 'Source Han Serif SC', serif";
const CONTEXT_PRESETS = [100, 300, 600, 1200];

const STUDY_THEME_CSS = `
.xiaowo-study {
    color: ${READER_INK};
}
.xiaowo-study button {
    transition: transform 160ms ease, background 160ms ease, border-color 160ms ease;
}
.xiaowo-study button:active {
    transform: scale(0.98);
}
.xiaowo-study ::selection {
    background: rgba(189, 93, 58, 0.18);
}
.xiaowo-study .no-scrollbar {
    scrollbar-width: none;
    -ms-overflow-style: none;
    -webkit-overflow-scrolling: touch;
}
.xiaowo-study .no-scrollbar::-webkit-scrollbar {
    width: 0;
    height: 0;
    display: none;
}
`;

const READER_PAGE_PADDING = '56px 28px calc(24px + env(safe-area-inset-bottom))';
const READER_VERTICAL_PADDING_STATIC = 88;
function getSafeAreaBottom(): number {
    if (typeof document === 'undefined') return 0;
    const probe = document.createElement('div');
    probe.style.cssText = 'position:fixed;bottom:0;left:0;width:0;padding-bottom:env(safe-area-inset-bottom);visibility:hidden;pointer-events:none;';
    document.body.appendChild(probe);
    const h = probe.offsetHeight;
    document.body.removeChild(probe);
    return h;
}
const READER_HORIZONTAL_PADDING = 56;
function decodeEntities(s: string): string {
    return s.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}
const PARA_GAP = 18;
const CHAPTER_GAP_TOP = 40;
const CHAPTER_GAP_BOTTOM = 28;

// 大书（对齐SullyOS共读室 v2.2.24）：不做窗口化——全局连续视觉分页。
// 超阈值的书首开走渐进分页：分块测量（块间让出主线程不卡UI）+ 完成后写分页缓存，之后秒开。
const PROGRESSIVE_MEASURE_THRESHOLD = 15000;
const PARA_FETCH_CHUNK = 10000;
const MEASURE_CHUNK = 1500;
// 目录行高（窗口化渲染用，固定行高才能按滚动位置直接换算可视窗口）
const TOC_ROW_H = 44;
// 后手优化：缓存miss时先分当前位置±PROVISIONAL_WIN段立即可读，全书分页后台补全
const PROVISIONAL_WIN = 2500;

function pageBreakIndexForAnchor(breaks: PageBreak[], paraIndex: number, charOffset = 0): number {
    if (paraIndex < 0 || breaks.length === 0) return 0;
    let answer = 0;
    for (let i = 0; i < breaks.length; i++) {
        const br = breaks[i];
        if (br.paraIndex < paraIndex || (br.paraIndex === paraIndex && br.offset <= charOffset)) answer = i;
        else if (br.paraIndex > paraIndex) break;
    }
    return answer;
}

// 分页/段落缓存主存 IndexedDB：大书分页结果几百KB起，localStorage(5-10MB)写不下
// 或被清理→每次重开都重分页。localStorage 只作 IDB 不可用时的后手兜底。
const idbOpen = (): Promise<IDBDatabase | null> => new Promise((resolve) => {
    try {
        const req = indexedDB.open('study-reader-cache', 2);
        req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains('pagebreaks')) db.createObjectStore('pagebreaks');
            if (!db.objectStoreNames.contains('paragraphs')) db.createObjectStore('paragraphs');
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
    } catch { resolve(null); }
});
const idbGet = (key: string): Promise<string | null> =>
    idbOpen().then(db => new Promise<string | null>((resolve) => {
        if (!db) return resolve(null);
        try {
            const req = db.transaction('pagebreaks', 'readonly').objectStore('pagebreaks').get(key);
            req.onsuccess = () => resolve(typeof req.result === 'string' ? req.result : null);
            req.onerror = () => resolve(null);
        } catch { resolve(null); }
    }));
const idbSet = (key: string, value: string): Promise<boolean> =>
    idbOpen().then(db => new Promise<boolean>((resolve) => {
        if (!db) return resolve(false);
        try {
            const tx = db.transaction('pagebreaks', 'readwrite');
            tx.objectStore('pagebreaks').put(value, key);
            tx.oncomplete = () => resolve(true);
            tx.onerror = () => resolve(false);
            tx.onabort = () => resolve(false);
        } catch { resolve(false); }
    }));
const idbDel = (key: string): Promise<void> =>
    idbOpen().then(db => new Promise<void>((resolve) => {
        if (!db) return resolve();
        try {
            const tx = db.transaction('pagebreaks', 'readwrite');
            tx.objectStore('pagebreaks').delete(key);
            tx.oncomplete = () => resolve();
            tx.onerror = () => resolve();
        } catch { resolve(); }
    }));
const idbGetParas = (key: string): Promise<string | null> =>
    idbOpen().then(db => new Promise<string | null>((resolve) => {
        if (!db) return resolve(null);
        try {
            const req = db.transaction('paragraphs', 'readonly').objectStore('paragraphs').get(key);
            req.onsuccess = () => resolve(typeof req.result === 'string' ? req.result : null);
            req.onerror = () => resolve(null);
        } catch { resolve(null); }
    }));
const idbSetParas = (key: string, value: string): Promise<boolean> =>
    idbOpen().then(db => new Promise<boolean>((resolve) => {
        if (!db) return resolve(false);
        try {
            const tx = db.transaction('paragraphs', 'readwrite');
            tx.objectStore('paragraphs').put(value, key);
            tx.oncomplete = () => resolve(true);
            tx.onerror = () => resolve(false);
            tx.onabort = () => resolve(false);
        } catch { resolve(false); }
    }));
const idbDelParas = (key: string): Promise<void> =>
    idbOpen().then(db => new Promise<void>((resolve) => {
        if (!db) return resolve();
        try {
            const tx = db.transaction('paragraphs', 'readwrite');
            tx.objectStore('paragraphs').delete(key);
            tx.oncomplete = () => resolve();
            tx.onerror = () => resolve();
        } catch { resolve(); }
    }));

function toast(msg: string) {
    const el = document.createElement('div');
    el.textContent = msg;
    Object.assign(el.style, { position: 'fixed', bottom: '80px', left: '50%', transform: 'translateX(-50%)', background: 'rgba(0,0,0,0.75)', color: '#fff', padding: '8px 20px', borderRadius: '20px', fontSize: '13px', zIndex: '9999', pointerEvents: 'none', transition: 'opacity 0.3s' });
    document.body.appendChild(el);
    setTimeout(() => { el.style.opacity = '0'; setTimeout(() => el.remove(), 300); }, 2000);
}

const StudyApp: React.FC = () => {
    const c = themeColors(245, 25, 65);

    const [mode, setMode] = useState<'shelf' | 'reading'>('shelf');
    const [books, setBooks] = useState<Book[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');

    const [activeBook, setActiveBook] = useState<Book | null>(null);
    const [paragraphs, setParagraphs] = useState<Paragraph[]>([]);
    const [comments, setComments] = useState<Comment[]>([]);
    const [page, setPage] = useState(1);
    const [totalPages, setTotalPages] = useState(1);
    const [pageBreaks, setPageBreaks] = useState<PageBreak[]>([{ paraIndex: 0, offset: 0 }]);
    // 大书首开渐进分页进度（0~1），非 null 时 loading 显示百分比
    const [paginateProgress, setPaginateProgress] = useState<number | null>(null);
    const [pageFragments, setPageFragments] = useState<PageFragment[]>([]);
    const [readingLoading, setReadingLoading] = useState(false);
    const contentRef = useRef<HTMLDivElement>(null);
    const measureRef = useRef<HTMLDivElement>(null);
    const [allParas, setAllParas] = useState<Paragraph[]>([]);
    const [allComments, setAllComments] = useState<Comment[]>([]);
    const [bookmark, setBookmark] = useState<Bookmark | null>(null);
    const [pageHeight, setPageHeight] = useState(0);
    const [readerSize, setReaderSize] = useState({ width: 0, height: 0 });
    const savedParaIdxRef = useRef<number | null>(null);
    const savedCharOffsetRef = useRef(0);
    const currentParaIdxRef = useRef<number | null>(null);
    const currentPositionRef = useRef<{ page: number; paragraphIdx: number | null; charOffset: number }>({ page: 1, paragraphIdx: null, charOffset: 0 });
    const progressWriteTailRef = useRef<Promise<unknown>>(Promise.resolve());
    const restoringProgressRef = useRef(false);
    const openGenerationRef = useRef(0);
    // 后手优化：临时页表覆盖的段落区间（非null=全书分页仍在后台补全，窗外跳转先拦住）
    const provisionalRangeRef = useRef<{ from: number; to: number } | null>(null);

    const [commentingIdx, setCommentingIdx] = useState<number | null>(null);
    const [commentText, setCommentText] = useState('');
    const [selectedText, setSelectedText] = useState('');
    const [selRange, setSelRange] = useState<{ startPara: number; endPara: number; start: number; end: number } | null>(null);
    // 行间批注：不再用底部弹层，改成焦点态——高亮的批注 thread 滚进视野并轻微强调。
    const [focusedThreadId, setFocusedThreadId] = useState<number | null>(null);
    const [replyingTo, setReplyingTo] = useState<Comment | null>(null);
    const [newReplies, setNewReplies] = useState<ReplyNotice[]>([]);
    const [showReplies, setShowReplies] = useState(false);
    const [returnPoint, setReturnPoint] = useState<{ page: number; paraIdx: number | null } | null>(null);
    const [floatingBar, setFloatingBar] = useState<{ startPara: number; endPara: number; text: string; start: number; end: number } | null>(null);

    // 共读上下文范围（±字符数）。同一个值 Phase 3 同时用于「批注触发 AI」和
    // 「从选中句主动讨论」。localStorage 只作即时回显，真值以服务端 config 表为准。
    const [contextChars, setContextCharsState] = useState<number>(() => {
        const v = parseInt(localStorage.getItem('coread-context-chars') || '300', 10);
        return Number.isFinite(v) && v >= 50 && v <= 5000 ? v : 300;
    });
    const [contextCustom, setContextCustom] = useState(() => !CONTEXT_PRESETS.includes(
        parseInt(localStorage.getItem('coread-context-chars') || '300', 10)
    ));
    const contextSaveTimer = useRef<any>(null);
    const setContextChars = useCallback((value: number) => {
        const clamped = Math.min(5000, Math.max(50, Math.round(value || 0) || 300));
        setContextCharsState(clamped);
        localStorage.setItem('coread-context-chars', String(clamped));
        if (contextSaveTimer.current) clearTimeout(contextSaveTimer.current);
        contextSaveTimer.current = setTimeout(() => {
            api.updateSettings({ context_chars: clamped }).catch(() => {});
        }, 500);
    }, []);
    useEffect(() => {
        api.fetchSettings().then((d: any) => {
            const v = Number(d?.context_chars);
            if (Number.isFinite(v) && v >= 50 && v <= 5000) {
                setContextCharsState(v);
                localStorage.setItem('coread-context-chars', String(v));
                setContextCustom(!CONTEXT_PRESETS.includes(v));
            }
        }).catch(() => {});
    }, []);

    // 共读绑定（CoRead Final）：批注持续投给哪个既有 cc 聊天会话。不是"最近聊天"，
    // 是 vv 手动选定、持久化在 Morrow 一侧、重启也不变的固定目标——这里只负责
    // 显示当前绑定 + 提供选择器，真正的解析/校验在 Morrow 服务端。
    const [coreadBinding, setCoreadBinding] = useState<CoreadBinding | null>(null);
    const [showBindingPicker, setShowBindingPicker] = useState(false);
    const [bindingCandidates, setBindingCandidates] = useState<BindingCandidate[]>([]);
    const [bindingLoading, setBindingLoading] = useState(false);
    const [bindingError, setBindingError] = useState<string | null>(null);
    const refreshCoreadBinding = useCallback(() => {
        api.fetchCoreadBinding().then((d: any) => setCoreadBinding(d)).catch(() => setCoreadBinding(null));
    }, []);
    useEffect(() => { refreshCoreadBinding(); }, [refreshCoreadBinding]);
    const openBindingPicker = useCallback(() => {
        setBindingError(null);
        setShowBindingPicker(true);
        setBindingLoading(true);
        api.fetchCoreadBindingCandidates()
            .then((d: any) => setBindingCandidates(Array.isArray(d?.sessions) ? d.sessions : []))
            .catch(() => setBindingError('会话列表加载失败'))
            .finally(() => setBindingLoading(false));
    }, []);
    const chooseBindingCandidate = useCallback((sessionId: string) => {
        setBindingError(null);
        api.updateCoreadBinding(sessionId)
            .then((d: any) => { setCoreadBinding(d); setShowBindingPicker(false); })
            .catch(() => setBindingError('绑定失败，请重试'));
    }, []);
    const unbindCoread = useCallback(() => {
        setBindingError(null);
        api.clearCoreadBinding()
            .then(() => { setCoreadBinding({ sessionId: null, valid: false, reason: 'unbound', session: null }); setShowBindingPicker(false); })
            .catch(() => setBindingError('解绑失败，请重试'));
    }, []);

    const [showToc, setShowToc] = useState(false);
    const [tocChapters, setTocChapters] = useState<{ idx: number; page: number; title: string }[]>([]);
    const tocListRef = useRef<HTMLDivElement>(null);
    // 目录窗口化：滚动位置与视口高（只渲染可视区±缓冲，几千章不全量挂DOM）
    const [tocScrollTop, setTocScrollTop] = useState(0);
    const [tocViewH, setTocViewH] = useState(0);
    const commentsRef = useRef<Comment[]>([]);
    const allCommentsRef = useRef<Comment[]>([]);
    const suppressPageJumpRef = useRef(false);
    const replyPageRef = useRef<number | null>(null);

    const [showUpload, setShowUpload] = useState(false);
    const [uploadTitle, setUploadTitle] = useState('');
    const [uploadText, setUploadText] = useState('');
    const [pdfBase64, setPdfBase64] = useState('');
    const [uploadFileName, setUploadFileName] = useState('');
    const [uploading, setUploading] = useState(false);
    const fileInputRef = useRef<HTMLInputElement>(null);

    const [editMode, setEditMode] = useState(false);
    const [selectedBooks, setSelectedBooks] = useState<Set<number>>(new Set());
    const batchFileRef = useRef<HTMLInputElement>(null);
    const [showBar, setShowBar] = useState(false);
    const [humanName, setHumanName] = useState(() => localStorage.getItem('coread-human-name') || 'human');
    const [aiName, setAiName] = useState(() => localStorage.getItem('coread-ai-name') || 'AI');
    const [showSettings, setShowSettings] = useState(false);
    const [readerFontSize, setReaderFontSize] = useState(() => parseInt(localStorage.getItem('coread-font-size') || '14', 10));
    const [showFontPanel, setShowFontPanel] = useState(false);
    const [showBookmarkMenu, setShowBookmarkMenu] = useState(false);
    const [showMoreMenu, setShowMoreMenu] = useState(false);
    const [readerBrightness, setReaderBrightness] = useState(() => parseInt(localStorage.getItem('coread-brightness') || '100', 10));
    const [readerNightMode, setReaderNightMode] = useState(() => localStorage.getItem('coread-night-mode') === 'true');
    const displayName = (from: string) => {
        const lower = from.toLowerCase();
        if (lower === 'human' || lower === humanName.toLowerCase()) return humanName;
        if (lower === 'ai' || lower === aiName.toLowerCase()) return aiName;
        return from;
    };
    const barTimer = useRef<any>(null);
    const touchStart = useRef<{ x: number; y: number; t: number } | null>(null);

    const toggleBar = () => {
        if (focusedThreadId != null) { setFocusedThreadId(null); return; }
        if (floatingBar) return;
        setShowBar(prev => {
            const next = !prev;
            if (barTimer.current) clearTimeout(barTimer.current);
            if (next) barTimer.current = setTimeout(() => setShowBar(false), 5000);
            return next;
        });
    };

    useEffect(() => { loadBooks(); }, []);

    // Real-time comment sync — low-priority update, no flash
    useEffect(() => { commentsRef.current = comments; }, [comments]);
    useEffect(() => { allCommentsRef.current = allComments; }, [allComments]);

    const lastCommentIds = useRef('');
    useEffect(() => {
        if (mode !== 'reading' || !activeBook) return;
        const interval = setInterval(async () => {
            try {
                const d = await api.fetchBookDetail(activeBook.id, page);
                if (d.comments) {
                    const newIds = d.comments.map((c: any) => c.id).join(',');
                    if (newIds !== lastCommentIds.current) {
                        lastCommentIds.current = newIds;
                        startTransition(() => {
                            const mergeComments = (prev: Comment[]) => {
                                const merged = new Map(prev.map(c => [c.id, c]));
                                d.comments.forEach((cmt: Comment) => {
                                    const tempDup = Array.from(merged.values()).find(c => c.id !== cmt.id && c.content === cmt.content && c.from_who === cmt.from_who && c.paragraph_idx === cmt.paragraph_idx && c.reply_to === cmt.reply_to && Math.abs(new Date(c.created_at).getTime() - new Date(cmt.created_at).getTime()) < 10000);
                                    if (tempDup) merged.delete(tempDup.id);
                                    merged.set(cmt.id, cmt);
                                });
                                return Array.from(merged.values());
                            };
                            setAllComments(mergeComments);
                            setComments(mergeComments);
                        });
                    }
                }
            } catch {}
        }, 3000);
        return () => clearInterval(interval);
    }, [mode, activeBook?.id, page]);

    const persistProgressPosition = (bookId: number, position: { page: number; paragraphIdx: number | null; charOffset: number }, keepalive = false) => {
        if (position.paragraphIdx === null || !Number.isSafeInteger(position.paragraphIdx)) return Promise.resolve();
        if (keepalive) {
            return api.updateBookProgress(bookId, position.paragraphIdx, position.charOffset, { keepalive: true }).catch(() => {});
        }
        const next = progressWriteTailRef.current
            .catch(() => {})
            .then(() => api.updateBookProgress(bookId, position.paragraphIdx!, position.charOffset));
        progressWriteTailRef.current = next.catch(() => {});
        return next;
    };

    const persistCurrentPosition = (keepalive = false) => {
        if (!activeBook) return Promise.resolve();
        return persistProgressPosition(activeBook.id, currentReaderPosition(), keepalive);
    };

    // The normal page effect persists on every page change. These lifecycle
    // hooks cover leaving the reader without another React render (refresh,
    // app switch, or Android WebView suspension).
    useEffect(() => {
        if (mode !== 'reading' || !activeBook) return undefined;
        const flush = () => { persistProgressPosition(activeBook.id, currentPositionRef.current, true); };
        const onVisibilityChange = () => { if (document.visibilityState === 'hidden') flush(); };
        window.addEventListener('pagehide', flush);
        document.addEventListener('visibilitychange', onVisibilityChange);
        return () => {
            window.removeEventListener('pagehide', flush);
            document.removeEventListener('visibilitychange', onVisibilityChange);
        };
    }, [mode, activeBook?.id]);

    // Poll for new replies from 沉
    useEffect(() => {
        if (mode !== 'reading' || !activeBook) return;
        const check = async () => {
            try {
                const lastSeen = parseInt(localStorage.getItem(`book-${activeBook.id}-last-seen`) || '0');
                const r = await fetch(coreadPath(`/v1/books/${activeBook.id}/new-replies?since=${lastSeen}`));
                if (r.ok) {
                    const d = await r.json();
                    const aiOnly = (d.replies || []).filter((r: any) => r.from_who.toLowerCase() !== humanName.toLowerCase());
                    setNewReplies(aiOnly.length ? aiOnly : []);
                }
            } catch {}
        };
        check();
        const interval = setInterval(check, 5000);
        return () => clearInterval(interval);
    }, [mode, activeBook?.id]);

    const dismissReplies = () => {
        if (activeBook && newReplies.length) {
            const maxId = Math.max(...newReplies.map(r => r.id));
            localStorage.setItem(`book-${activeBook.id}-last-seen`, String(maxId));
        }
        setNewReplies([]);
        setShowReplies(false);
    };

    const findPageForParaIdx = (paraIdx: number, maxPages = totalPages, charOffset = 0) => {
        const targetParaIdx = Number(paraIdx);
        const targetOffset = Number(charOffset) || 0;
        let paraIndex = allParas.findIndex(p => Number(p.idx) === targetParaIdx);
        if (paraIndex < 0) paraIndex = allParas.findIndex(p => Number(p.idx) >= targetParaIdx);
        if (paraIndex < 0) return -1;

        const lastPage = Math.min(maxPages, pageBreaks.length) - 1;
        // 二分：breaks 按 (paraIndex, offset) 单调递增；大书目录几千章逐个换算页码，线性扫会卡
        let lo = 0, hi = lastPage, ans = 0;
        while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            const br = pageBreaks[mid];
            if (br.paraIndex < paraIndex || (br.paraIndex === paraIndex && br.offset <= targetOffset)) { ans = mid; lo = mid + 1; }
            else hi = mid - 1;
        }
        return ans;
    };

    // 后台补全分页中：临时页表只覆盖当前位置附近，窗外目标等全书分页完成再跳
    const canJumpToPara = (idx: number) => {
        const pr = provisionalRangeRef.current;
        if (!pr) return true;
        const tpi = allParas.findIndex(p => Number(p.idx) >= Number(idx));
        if (tpi >= pr.from && tpi < pr.to) return true;
        toast('全书分页后台补全中，完成后再跳');
        return false;
    };

    const resolveNoticeTarget = (notice: ReplyNotice, pool: Comment[]) => {
        const existing = pool.find(c => c.id === notice.id);
        const replyTo = notice.reply_to ?? notice.parent_id ?? existing?.reply_to ?? null;
        const parent = replyTo ? pool.find(c => c.id === replyTo) : null;
        const target = parent || existing;
        const fallbackPara = Number(notice.parent_paragraph_idx ?? notice.paragraph_idx);
        const fallbackOffset = Number(notice.parent_sel_start_idx ?? notice.sel_start_idx);
        return {
            existing,
            replyTo,
            parent,
            paraIdx: Number(target?.paragraph_idx ?? fallbackPara),
            offset: Number.isFinite(Number(target?.sel_start_idx)) ? Number(target?.sel_start_idx) : (Number.isFinite(fallbackOffset) ? fallbackOffset : 0),
        };
    };

    const rememberReturnPoint = () => {
        setReturnPoint(prev => prev || { page, paraIdx: currentParaIdxRef.current ?? paragraphs[0]?.idx ?? null });
    };

    const returnToReadingPosition = () => {
        if (!returnPoint) return;
        setFocusedThreadId(null);
        setShowReplies(false);
        setShowBar(false);
        const targetPage = returnPoint.paraIdx != null ? findPageForParaIdx(returnPoint.paraIdx) : -1;
        setPage(targetPage >= 0 ? targetPage + 1 : Math.max(1, Math.min(totalPages, returnPoint.page)));
        setReturnPoint(null);
    };

    const openReplyNotice = (notice: ReplyNotice) => {
        rememberReturnPoint();
        setShowReplies(false);
        setShowBar(false);
        const pool = Array.from(new Map([...allCommentsRef.current, ...commentsRef.current].map(c => [c.id, c])).values());
        const { existing, replyTo, parent, paraIdx: targetParaIdx, offset: targetOffset } = resolveNoticeTarget(notice, pool);
        const targetPage = findPageForParaIdx(targetParaIdx, totalPages, targetOffset);
        if (targetPage >= 0) setPage(targetPage + 1);
        if (!existing) {
            const noticeComment: Comment = {
                id: notice.id,
                book_id: activeBook?.id ?? 0,
                paragraph_idx: targetParaIdx,
                sel_end_para_idx: null,
                sel_start_idx: targetOffset,
                sel_end_idx: notice.parent_sel_end_idx ?? notice.sel_end_idx ?? null,
                selected_text: notice.parent_selected_text ?? notice.selected_text ?? null,
                from_who: notice.from_who || 'ai',
                content: notice.content,
                created_at: notice.created_at || new Date().toISOString(),
                reply_to: replyTo,
            };
            setComments(prev => prev.some(c => c.id === noticeComment.id) ? prev : [...prev, noticeComment]);
            setAllComments(prev => prev.some(c => c.id === noticeComment.id) ? prev : [...prev, noticeComment]);
        }
        // 焦点落在 thread 顶层：行间 thread 会滚进视野并轻微强调。
        setFocusedThreadId((parent?.id ?? replyTo) ?? notice.id);
    };

    // Selection change listener for floating annotation bar
    useEffect(() => {
        if (mode !== 'reading') return;
        const findPara = (n: Node): HTMLElement | null => {
            let el: HTMLElement | null = (n.nodeType === Node.TEXT_NODE ? n.parentElement : n) as HTMLElement;
            while (el && !(el as any).dataset?.paraIdx) el = el.parentElement;
            return el;
        };
        const handler = () => {
            const sel = window.getSelection();
            if (!sel || !sel.toString().trim() || sel.rangeCount === 0) { setFloatingBar(null); return; }
            const range = sel.getRangeAt(0);
            const startEl = findPara(range.startContainer);
            const endEl = findPara(range.endContainer);
            if (!startEl || !endEl) { setFloatingBar(null); return; }

            const startPara = parseInt((startEl as any).dataset.paraIdx);
            const endPara = parseInt((endEl as any).dataset.paraIdx);
            const text = sel.toString().trim();
            try {
                const pre1 = document.createRange();
                pre1.selectNodeContents(startEl);
                pre1.setEnd(range.startContainer, range.startOffset);
                const startBase = parseInt((startEl as any).dataset.fragStart || '0');
                const endBase = parseInt((endEl as any).dataset.fragStart || '0');
                const startOff = startBase + pre1.toString().length;

                let endOff: number;
                if (startPara === endPara) {
                    endOff = startOff + text.length;
                } else {
                    const pre2 = document.createRange();
                    pre2.selectNodeContents(endEl);
                    pre2.setEnd(range.endContainer, range.endOffset);
                    endOff = endBase + pre2.toString().length;
                }
                setFloatingBar({ startPara, endPara, text, start: startOff, end: endOff });
            } catch { setFloatingBar(null); }
        };
        document.addEventListener('selectionchange', handler);
        return () => document.removeEventListener('selectionchange', handler);
    }, [mode]);

    // 焦点批注：把对应的行间 thread 滚进视野中央（阅读区现在可纵向滚动，容得下页边批注）。
    useEffect(() => {
        if (focusedThreadId == null || mode !== 'reading') return;
        const t = setTimeout(() => {
            const el = contentRef.current?.querySelector(`[data-thread-anchor="${focusedThreadId}"]`);
            (el as HTMLElement | null)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
        }, 60);
        return () => clearTimeout(t);
    }, [focusedThreadId, mode, page, pageFragments]);

    const loadBooks = async () => {
        setLoading(true); setError('');
        try { const d = await api.fetchBooks(); setBooks(d.books || []); }
        catch (e: any) { setError(e.message); }
        setLoading(false);
    };

    const openBook = async (book: Book) => {
        const generation = ++openGenerationRef.current;
        setActiveBook(book); setMode('reading');
        setReadingLoading(true);
        setPage(1); setTotalPages(1); setPageBreaks([{ paraIndex: 0, offset: 0 }]); setPageFragments([]); setPaginateProgress(null);
        setParagraphs([]); setComments([]); setAllParas([]); setAllComments([]);
        setBookmark(book.bookmark_page != null && book.bookmark_paragraph_idx != null ? {
            page: book.bookmark_page,
            paragraph_idx: book.bookmark_paragraph_idx,
            char_offset: book.bookmark_offset || 0,
            updated_at: book.bookmark_updated_at,
        } : null);
        currentParaIdxRef.current = null;
        currentPositionRef.current = { page: 1, paragraphIdx: null, charOffset: 0 };
        provisionalRangeRef.current = null;
        restoringProgressRef.current = true;
        savedParaIdxRef.current = Number.isSafeInteger(Number(book.current_page)) ? Number(book.current_page) : null;
        savedCharOffsetRef.current = Number.isSafeInteger(Number(book.current_offset)) ? Number(book.current_offset) : 0;
        api.fetchBookBookmark(book.id).then((d: any) => {
            if (openGenerationRef.current === generation) setBookmark(d.bookmark || null);
        }).catch(() => {});
        {
            const bookTitle = book.title?.replace(/\s*\(.*?\)\s*/g, '').trim();
            fetch('/v1/reading-wishlist').then(r => r.json()).then(res => {
                const match = (res.items || []).find((w: any) => w.status === 'want' && w.title?.trim() === bookTitle);
                if (match) {
                    fetch('/v1/reading-wishlist', {
                        method: 'POST', headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ id: match.id, title: match.title, author: match.author, reason: match.reason, status: 'reading' }),
                    }).catch(() => {});
                }
            }).catch(() => {});
        }
        try {
            const totalParas = Math.max(1, book.total_paragraphs || 0);
            const paraCacheKey = `paras-v1-${book.id}`;
            const commentCacheKey = `comments-v1-${book.id}`;
            let cacheHit = false;
            // 段落内容也进 IndexedDB：二次打开跳过网络拉取（大书13万段逐块拉要约1-2分钟）
            try {
                const cached = await idbGetParas(paraCacheKey);
                if (cached) {
                    const parsed = JSON.parse(cached);
                    if (parsed.totalParas === totalParas && Array.isArray(parsed.paragraphs) && parsed.paragraphs.length > 0) {
                        setAllParas(parsed.paragraphs);
                        const cachedComments = await idbGetParas(commentCacheKey);
                        const comments = cachedComments ? JSON.parse(cachedComments) : [];
                        setAllComments(comments);
                        setComments(comments);
                        cacheHit = true;
                        api.fetchBookDetail(book.id, 1).then((d: any) => {
                            if (openGenerationRef.current !== generation) return;
                            if (Array.isArray(d.comments)) {
                                setAllComments(d.comments);
                                setComments(d.comments);
                                idbSetParas(commentCacheKey, JSON.stringify(d.comments)).catch(() => {});
                            }
                            if (d.bookmark) setBookmark(d.bookmark);
                        }).catch(() => {});
                    }
                }
            } catch {}
            if (!cacheHit) {
                // 全书分块拉取：小书1块、大书多块（避免单次大响应内存峰值，也修掉9999段截断）；批注随块增量合并。
                // 各块之间没有依赖，起点从 totalParas 提前算好，并发拉（限流避免一次性打爆连接数），
                // 比逐块 await 快了一个并发倍数——大书原来要1-2分钟，这一步是主要瓶颈之一。
                const rawParas: Paragraph[] = [];
                const fetchedComments: Comment[] = [];
                const seenCommentIds = new Set<number>();
                const chunkStarts: number[] = [];
                for (let start = 0; start < totalParas; start += PARA_FETCH_CHUNK) chunkStarts.push(start);
                const chunkResults: any[] = new Array(chunkStarts.length);
                const CHUNK_CONCURRENCY = 4;
                let nextChunk = 0;
                const fetchWorker = async () => {
                    while (nextChunk < chunkStarts.length) {
                        const i = nextChunk++;
                        chunkResults[i] = await api.fetchBookSlice(book.id, chunkStarts[i], PARA_FETCH_CHUNK);
                    }
                };
                await Promise.all(Array.from({ length: Math.min(CHUNK_CONCURRENCY, chunkStarts.length) }, fetchWorker));
                for (const d of chunkResults) {
                    if (!d) continue;
                    rawParas.push(...(d.paragraphs || []));
                    for (const cmt of (d.comments || []) as Comment[]) {
                        if (!seenCommentIds.has(cmt.id)) { seenCommentIds.add(cmt.id); fetchedComments.push(cmt); }
                    }
                }
                const isEpubJunk = (s: string) => /^(1UR057|Cover|封面|插图|导航|书名页|制作信息|Contents|[A-Z0-9]{3,10}(-\d+)?)$/.test(s.trim());
                const allP: Paragraph[] = rawParas.filter((p: Paragraph) => !isEpubJunk(p.content));
                // Hide TOC sections (目录 heading + consecutive chapter titles)
                const tocRe = /^(#\s*)?目录$/;
                const chRe = /^(第[\d一二三四五六七八九十百千万]+[章节回部篇]|序章|序$|终章|后记|尾声|附录|解说)/;
                let tocZone = false;
                const filtered = allP.filter(p => {
                    const t = p.content.trim();
                    if (tocRe.test(t)) { tocZone = true; return false; }
                    if (tocZone) { if (chRe.test(t) || t === '') return false; tocZone = false; }
                    return true;
                });
                setAllParas(filtered);
                setAllComments(fetchedComments);
                setComments(fetchedComments);
                // 有内容时loading由分页effect跳页完成后关闭——这里提前关会先露出第1页再跳（闪烁）
                if (filtered.length === 0) {
                    restoringProgressRef.current = false;
                    setReadingLoading(false);
                }
                idbSetParas(paraCacheKey, JSON.stringify({ paragraphs: filtered, totalParas })).catch(() => {});
                idbSetParas(commentCacheKey, JSON.stringify(fetchedComments)).catch(() => {});
            }
        } catch (e: any) { toast(`加载失败: ${e.message}`); setReadingLoading(false); }
        api.fetchBookToc(book.id).then(d => setTocChapters(d.chapters || [])).catch(() => {});
    };

    const lockedHeightRef = useRef<number>(0);
    useLayoutEffect(() => {
        if (mode !== 'reading' || !contentRef.current) return;
        const el = contentRef.current;
        let frame = 0;
        const update = (force?: boolean) => {
            cancelAnimationFrame(frame);
            frame = requestAnimationFrame(() => {
                const width = Math.round(el.clientWidth);
                const rawH = Math.min(el.clientHeight, window.innerHeight);
                const height = Math.max(0, Math.round(rawH - READER_VERTICAL_PADDING_STATIC - getSafeAreaBottom()));
                if (lockedHeightRef.current === 0 || force) {
                    lockedHeightRef.current = height;
                }
                const stableH = Math.max(height, lockedHeightRef.current);
                setReaderSize(prev => {
                    if (prev.width === width && prev.height === stableH) return prev;
                    return { width, height: stableH };
                });
            });
        };
        update(true);
        const onResize = () => {
            const rawH = Math.min(el.clientHeight, window.innerHeight);
            const h = Math.max(0, Math.round(rawH - READER_VERTICAL_PADDING_STATIC - getSafeAreaBottom()));
            if (h >= lockedHeightRef.current * 0.95) {
                update(true);
            } else {
                const width = Math.round(el.clientWidth);
                setReaderSize(prev => prev.width === width ? prev : { width, height: prev.height });
            }
        };
        const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => onResize()) : null;
        ro?.observe(el);
        window.addEventListener('resize', onResize);
        return () => {
            cancelAnimationFrame(frame);
            ro?.disconnect();
            window.removeEventListener('resize', onResize);
            lockedHeightRef.current = 0;
        };
    }, [mode]);

    const readerContentWidth = Math.max(1, readerSize.width - READER_HORIZONTAL_PADDING);

    // 同书只存一份分页缓存，value里带测量时的尺寸，读取时容差校验。
    // 不能把精确像素拼进key：手机WebView每次打开视口差±几px，key永远miss，导致每次进书全书重新measure。
    // v3：正文换成衬线体，旧的（无衬线测量的）分页缓存必须失效重算。
    const paginationCacheKey = activeBook ? `pagebreaks-v3-${activeBook.id}-fs${readerFontSize}` : '';
    const imgHeightCache = useRef<Map<string, number>>(new Map());

    const buildMeasureBlock = (para: Paragraph, sourceIdx: number, start: number, end: number) => {
        const heading = isHeading(para.content);
        const chapterTitle = isChapterStart(para.content);
        const outer = document.createElement('div');
        outer.style.marginTop = `${chapterTitle && start === 0 && sourceIdx > 0 ? CHAPTER_GAP_TOP : 0}px`;
        outer.style.marginBottom = `${chapterTitle ? CHAPTER_GAP_BOTTOM : PARA_GAP}px`;

        const imgMatch = para.content.match(/^\[IMG:([^\]]+)\]$/);
        if (imgMatch && start === 0) {
            const imgMaxH = Math.floor(readerSize.height * 0.6);
            const cachedH = imgHeightCache.current.get(imgMatch[1]);
            const h = cachedH ? Math.min(cachedH, imgMaxH) : imgMaxH;
            const imgEl = document.createElement('div');
            imgEl.style.height = `${h}px`;
            imgEl.style.width = '100%';
            outer.appendChild(imgEl);
        } else {
            const displayText = stripHeading(para.content).slice(start, end);
            const inner = document.createElement('div');
            inner.textContent = displayText || ' ';
            inner.style.fontSize = `${chapterTitle ? readerFontSize + 4 : para.content.trim().startsWith('# ') ? readerFontSize + 3 : para.content.trim().startsWith('## ') ? readerFontSize + 2 : readerFontSize}px`;
            inner.style.lineHeight = String(chapterTitle ? 2.2 : 1.85);
            inner.style.letterSpacing = `${chapterTitle ? 1 : 0.3}px`;
            inner.style.textIndent = heading || chapterTitle || start > 0 ? '0' : '1.5em';
            inner.style.fontWeight = String(chapterTitle ? 800 : heading ? 700 : 400);
            inner.style.textAlign = chapterTitle ? 'center' : '';
            inner.style.whiteSpace = 'pre-wrap';
            // 分页测量的字体必须与正文渲染一致，否则断行/页数漂移。
            inner.style.fontFamily = READER_SERIF;
            outer.appendChild(inner);
        }


        return outer;
    };

    useEffect(() => {
        if (mode !== 'reading' || !measureRef.current || allParas.length === 0 || readerContentWidth <= 1 || readerSize.height <= 0) return;
        let cancelled = false;
        const run = async () => {
            await (document.fonts as any)?.ready?.catch(() => {});
            await new Promise<void>(r => requestAnimationFrame(() => r()));
            if (cancelled || !measureRef.current) return;

            if (activeBook && allParas.length <= PROGRESSIVE_MEASURE_THRESHOLD) {
                const imgParas = allParas.filter(p => /^\[IMG:([^\]]+)\]$/.test(p.content));
                const loadPromises = imgParas.map(p => {
                    const m = p.content.match(/^\[IMG:([^\]]+)\]$/);
                    if (!m || imgHeightCache.current.has(m[1])) return Promise.resolve();
                    return new Promise<void>(resolve => {
                        const img = new Image();
                        img.onload = () => {
                            const maxW = readerContentWidth;
                            const maxH = Math.floor(readerSize.height * 0.6);
                            const scale = Math.min(maxW / img.naturalWidth, maxH / img.naturalHeight, 1);
                            imgHeightCache.current.set(m![1], img.naturalHeight * scale);
                            resolve();
                        };
                        img.onerror = () => resolve();
                        img.src = api.imageUrl(activeBook!.id, m[1]);
                    });
                });
                await Promise.all(loadPromises);
            }
            if (cancelled || !measureRef.current) return;

            const measurer = measureRef.current;
            measurer.innerHTML = '';
            measurer.style.width = `${readerContentWidth}px`;
            const maxHeight = Math.max(100, readerSize.height - 8);
            setPageHeight(readerSize.height);
            const progressive = allParas.length > PROGRESSIVE_MEASURE_THRESHOLD;
            provisionalRangeRef.current = null;

            // 后手优化判定——缓存miss且锚点够靠后时，先快速分当前位置±PROVISIONAL_WIN段的临时页
            // 立即可读，全书分页随后照常从0跑完后替换
            const anchorIdx0 = savedParaIdxRef.current ?? currentParaIdxRef.current ?? allParas[0]?.idx ?? 0;
            const anchorOffset0 = savedParaIdxRef.current !== null ? savedCharOffsetRef.current : currentPositionRef.current.charOffset;
            const anchorPi0 = allParas.findIndex(p => p.idx >= anchorIdx0);
            const useProvisional = progressive && !suppressPageJumpRef.current && anchorPi0 > PROVISIONAL_WIN;

            // Try cache first（IndexedDB 主存；localStorage 里的旧缓存读出后迁移进IDB）
            if (paginationCacheKey) {
                try {
                    let cached = await idbGet(paginationCacheKey);
                    if (cancelled) return;
                    if (!cached) {
                        cached = localStorage.getItem(paginationCacheKey);
                        if (cached) idbSet(paginationCacheKey, cached);
                    }
                    if (cached) {
                        const { breaks: cachedBreaks, paraCount, width: cw, height: ch } = JSON.parse(cached);
                        // 尺寸容差：宽±2px严格（影响断行）；高±80px宽松——高度只影响每页容量/页尾留白，
                        // 大书重测要约1分钟，手机WebView每次打开视口抖几十px不该触发重分页
                        const sizeOk = typeof cw === 'number' && typeof ch === 'number'
                            && Math.abs(cw - readerContentWidth) <= 2 && Math.abs(ch - readerSize.height) <= 80;
                        if (sizeOk && paraCount === allParas.length && Array.isArray(cachedBreaks) && cachedBreaks.length > 0) {
                            setPageBreaks(cachedBreaks);
                            setTotalPages(Math.max(1, cachedBreaks.length));
                            if (!suppressPageJumpRef.current) {
                                const anchorIdx = savedParaIdxRef.current ?? currentParaIdxRef.current ?? allParas[0]?.idx ?? 0;
                                const pi = allParas.findIndex(p => p.idx >= anchorIdx);
                                const anchorOffset = savedParaIdxRef.current !== null ? savedCharOffsetRef.current : currentPositionRef.current.charOffset;
                                const targetPage = pageBreakIndexForAnchor(cachedBreaks, pi, anchorOffset);
                                setPage(Math.max(1, Math.min(cachedBreaks.length, targetPage + 1)));
                            }
                            savedParaIdxRef.current = null;
                            savedCharOffsetRef.current = 0;
                            restoringProgressRef.current = false;
                            setReadingLoading(false);
                            return;
                        }
                    } else if (progressive) {
                        toast(useProvisional ? '无分页缓存，先打开当前位置，后台补全全书' : '无分页缓存，将完整分页一次');
                    }
                } catch {}
            }

            const breaks: PageBreak[] = [{ paraIndex: 0, offset: 0 }];

            // 连续排版 → 每块一次 layout，之后几何读取走缓存（layout 干净时读 rect 零 reflow）。
            // 旧算法逐段试塞，每段一次同步reflow，几千段=首开十几秒。
            // 切点全部落在行边界，所以续段在下一页重排时断行不变，几何坐标保持连续。
            // 大书（>PROGRESSIVE_MEASURE_THRESHOLD 段）分块挂载测量：块间让出主线程并更新进度，
            // 避免十几万段一次性 append 的内存峰值与长时间卡死；跨块用锚点段对齐逻辑纵坐标。
            const chapterTopGap = (i: number) =>
                isChapterStart(allParas[i].content) && i > 0 ? CHAPTER_GAP_TOP : 0;

            const measureRange = document.createRange();

            let blocks: HTMLElement[] = [];
            let blockRects: DOMRect[] = [];
            let chunkBase = 0;    // 当前块首段的数组下标
            let blockOffset = 0;  // 锚点段占位（1）或无（0）
            let rectShift = 0;    // 逻辑纵坐标 = DOM rect 读数 + rectShift
            let chunkEnd = 0;     // 当前块末段下标（不含）

            const blockIdx = (i: number) => i - chunkBase + blockOffset;
            const rectBottom = (i: number) => blockRects[blockIdx(i)].bottom + rectShift;
            const rectTop = (i: number) => blockRects[blockIdx(i)].top + rectShift;

            // 挂载 [from, from+MEASURE_CHUNK) 的测量块；anchorIdx=上一块末段（保留在容器顶做新旧坐标系对齐）
            const mountChunk = (from: number, anchorIdx: number | null, anchorLogicalBottom: number | null) => {
                measurer.innerHTML = '';
                blocks = [];
                if (anchorIdx != null && anchorIdx >= 0 && anchorIdx < from) {
                    const t0 = stripHeading(allParas[anchorIdx].content);
                    blocks.push(buildMeasureBlock(allParas[anchorIdx], anchorIdx, 0, t0.length));
                }
                blockOffset = blocks.length;
                const to = Math.min(allParas.length, from + MEASURE_CHUNK);
                for (let i = from; i < to; i++) {
                    const t = stripHeading(allParas[i].content);
                    blocks.push(buildMeasureBlock(allParas[i], i, 0, t.length));
                }
                for (const b of blocks) measurer.appendChild(b);
                blockRects = blocks.map(b => b.getBoundingClientRect());
                chunkBase = from;
                if (anchorIdx != null && anchorLogicalBottom != null && blockRects.length > 0) {
                    rectShift = anchorLogicalBottom - blockRects[0].bottom;
                }
            };

            const innerTextNode = (i: number): Text | null => {
                const inner = blocks[blockIdx(i)]?.firstElementChild;
                const node = inner?.firstChild;
                return node && node.nodeType === Node.TEXT_NODE ? (node as Text) : null;
            };

            // 前o个字符的包络底（逻辑纵坐标，单调递增），layout干净时读rect零reflow
            const bottomAt = (textNode: Text, o: number) => {
                measureRange.setStart(textNode, 0);
                measureRange.setEnd(textNode, Math.min(o, textNode.length));
                return measureRange.getBoundingClientRect().bottom + rectShift;
            };
            // 排满到limitY的最大行尾offset；一行都放不下返回0
            const lineCut = (i: number, limitY: number): number => {
                const textNode = innerTextNode(i);
                if (!textNode || textNode.length === 0) return 0;
                const len = textNode.length;
                if (bottomAt(textNode, len) <= limitY) return len;
                let lo = 1, hi = len, best = 0;
                while (lo <= hi) {
                    const mid = (lo + hi) >> 1;
                    if (bottomAt(textNode, mid) <= limitY) { best = mid; lo = mid + 1; }
                    else hi = mid - 1;
                }
                return best;
            };

            // 段 i 不在已挂载块内时换块：保留 i-1 段做锚点，逻辑纵坐标无缝接续；大书块间让出主线程
            const ensureChunk = async (i: number): Promise<boolean> => {
                if (i >= allParas.length || i < chunkEnd) return true;
                const anchorLogicalBottom = i > 0 ? rectBottom(i - 1) : 0;
                if (progressive) {
                    setPaginateProgress(Math.min(0.99, i / allParas.length));
                    await new Promise<void>(r => setTimeout(r, 0));
                    if (cancelled || !measureRef.current) return false;
                }
                mountChunk(i, i > 0 ? i - 1 : null, anchorLogicalBottom);
                chunkEnd = i + blocks.length - blockOffset;
                return true;
            };

            // 后手优化：临时页只按段界切（不做段中切分），与最终页表允许有出入，很快会被全书分页替换
            let provisionalShown = false;
            if (useProvisional) {
                const wFrom = anchorPi0 - PROVISIONAL_WIN;
                const wTo = Math.min(allParas.length, anchorPi0 + PROVISIONAL_WIN);
                const wb: PageBreak[] = [{ paraIndex: wFrom, offset: 0 }];
                let i = wFrom;
                let wCursor = 0;
                let wGuard = 0;
                while (i < wTo && wGuard++ < 10000) {
                    if (i >= chunkEnd) {
                        mountChunk(i, i > wFrom ? i - 1 : null, i > wFrom ? rectBottom(i - 1) : 0);
                        chunkEnd = i + blocks.length - blockOffset;
                        if (i === wFrom) wCursor = rectTop(wFrom) - chapterTopGap(wFrom);
                        await new Promise<void>(r => setTimeout(r, 0)); // 块间让出主线程
                        if (cancelled || !measureRef.current) return;
                        continue;
                    }
                    const limitY = wCursor + maxHeight + 1;
                    let pageHasContent = false;
                    while (i < chunkEnd && i < wTo) {
                        if (i > wFrom && isChapterStart(allParas[i].content) && pageHasContent) break;
                        if (rectBottom(i) <= limitY) { i++; pageHasContent = true; continue; }
                        // 整段/图片放不下：空页硬放（防死循环），否则推下一页
                        if (!pageHasContent) { i++; }
                        break;
                    }
                    if (i >= wTo || i >= chunkEnd) continue;
                    if (wb[wb.length - 1].paraIndex === i) break; // 没推进，防死循环
                    wb.push({ paraIndex: i, offset: 0 });
                    wCursor = rectTop(i) - chapterTopGap(i);
                }
                if (wb.length > 1) {
                    provisionalShown = true;
                    provisionalRangeRef.current = { from: wFrom, to: wTo };
                    setPageBreaks(wb);
                    setTotalPages(Math.max(1, wb.length));
                    const tp = pageBreakIndexForAnchor(wb, anchorPi0, anchorOffset0);
                    setPage(tp + 1);
                    savedParaIdxRef.current = null; // 锚点已用掉，全书分页完成时按实时阅读位置重映射
                    savedCharOffsetRef.current = 0;
                    restoringProgressRef.current = false;
                    setReadingLoading(false); // 立即可读；全书分页下面照常跑
                }
            }

            let pi = 0, off = 0;
            mountChunk(0, null, null);
            chunkEnd = blocks.length;
            let cursorY = blocks.length ? rectTop(0) - chapterTopGap(0) : 0;
            if (progressive) setPaginateProgress(0);
            let guard = 0;
            while (pi < allParas.length && guard++ < 100000) {
                if (!(await ensureChunk(pi))) return;
                const limitY = cursorY + maxHeight + 1; // +1对齐旧算法的subpixel容差
                let pageHasContent = false;
                while (pi < chunkEnd && pi < allParas.length) {
                    const isImg = /^\[IMG:[^\]]+\]$/.test(allParas[pi].content);
                    if (off === 0 && pi > 0 && isChapterStart(allParas[pi].content) && pageHasContent) break;
                    if (rectBottom(pi) <= limitY) {
                        pi++; off = 0; pageHasContent = true; continue;
                    }
                    if (isImg) {
                        // 图片不可拆；单独成页也放不下就硬放（imgMaxH≤0.6页高，实际必放得下）
                        if (!pageHasContent) { pi++; off = 0; pageHasContent = true; }
                        break;
                    }
                    const cut = lineCut(pi, limitY);
                    if (cut <= off) break; // 一行都进不来，整段推下页
                    if (cut >= (innerTextNode(pi)?.length ?? 0)) { // 文本全放下了（块底差subpixel）
                        pi++; off = 0; pageHasContent = true; continue;
                    }
                    // widow control: 段从头开始且只塞得下<4字且页内已有内容 → 整段推下页
                    if (off === 0 && cut < 4 && pageHasContent) break;
                    off = cut;
                    pageHasContent = true;
                    break;
                }
                if (pi >= allParas.length) break;
                if (pi >= chunkEnd) continue; // 块用完但页未填满：换块（ensureChunk）后继续填当前页
                const last = breaks[breaks.length - 1];
                if (last.paraIndex === pi && last.offset === off) break; // 没推进，防死循环
                breaks.push({ paraIndex: pi, offset: off });
                if (off > 0) {
                    // 段中切点：下一页顶=切点字符所在行的top
                    const textNode = innerTextNode(pi)!;
                    measureRange.setStart(textNode, Math.min(off, textNode.length));
                    measureRange.setEnd(textNode, Math.min(off + 1, textNode.length));
                    cursorY = measureRange.getBoundingClientRect().top + rectShift;
                } else {
                    cursorY = rectTop(pi) - chapterTopGap(pi);
                }
            }
            measurer.innerHTML = ''; // 测量节点用完即清

            if (cancelled) return;
            provisionalRangeRef.current = null; // 最终页表替换临时页表，解除窗外跳转拦截
            setPageBreaks(breaks);
            setTotalPages(Math.max(1, breaks.length));
            if (paginationCacheKey) {
                const payload = JSON.stringify({
                    breaks, paraCount: allParas.length,
                    width: readerContentWidth, height: readerSize.height,
                });
                // 清掉旧版精确像素key（pagebreaks-id-w-h），防localStorage堆积
                try {
                    for (let i = localStorage.length - 1; i >= 0; i--) {
                        const k = localStorage.key(i);
                        if (k && k.startsWith('pagebreaks-') && !k.startsWith('pagebreaks-v3-')) localStorage.removeItem(k);
                    }
                } catch {}
                // 主存 IndexedDB（配额足够，大书几百KB没问题）；写成功后清掉 localStorage 旧副本释放配额
                const idbOk = await idbSet(paginationCacheKey, payload);
                if (cancelled) return;
                if (idbOk) {
                    try { localStorage.removeItem(paginationCacheKey); } catch {}
                } else {
                    // 后手：IDB 不可用（隐私模式/老WebView）退回 localStorage；
                    // 配额满（大书缓存约几百KB，多本累计可能超限）则清掉其它书的分页缓存重试一次
                    try {
                        localStorage.setItem(paginationCacheKey, payload);
                    } catch {
                        try {
                            for (let i = localStorage.length - 1; i >= 0; i--) {
                                const k = localStorage.key(i);
                                if (k && k.startsWith('pagebreaks-v3-') && k !== paginationCacheKey) localStorage.removeItem(k);
                            }
                            localStorage.setItem(paginationCacheKey, payload);
                        } catch {}
                    }
                }
            }
            if (!suppressPageJumpRef.current) {
                const anchorIdx = savedParaIdxRef.current ?? currentParaIdxRef.current ?? allParas[0]?.idx ?? 0;
                const pi = allParas.findIndex(p => p.idx >= anchorIdx);
                const anchorOffset = savedParaIdxRef.current !== null ? savedCharOffsetRef.current : currentPositionRef.current.charOffset;
                const targetPage = pageBreakIndexForAnchor(breaks, pi, anchorOffset);
                setPage(Math.max(1, Math.min(breaks.length, targetPage + 1)));
            }
            savedParaIdxRef.current = null;
            savedCharOffsetRef.current = 0;
            restoringProgressRef.current = false;
            setPaginateProgress(null);
            setReadingLoading(false);
            if (provisionalShown) toast('全书分页已完成');
        };
        run();
        return () => { cancelled = true; };
    }, [mode, allParas, readerContentWidth, readerSize.height, readerFontSize]);

    useEffect(() => {
        if (allParas.length === 0 || pageBreaks.length === 0) {
            setPageFragments([]);
            setParagraphs([]);
            setComments([]);
            currentParaIdxRef.current = null;
            return;
        }
        if (page > pageBreaks.length && !suppressPageJumpRef.current) {
            setPage(pageBreaks.length);
            return;
        }
        const start = pageBreaks[page - 1] || { paraIndex: 0, offset: 0 };
        const end = page < pageBreaks.length ? pageBreaks[page] : { paraIndex: allParas.length, offset: 0 };
        const fragments: PageFragment[] = [];
        for (let i = start.paraIndex; i < end.paraIndex || (i === end.paraIndex && end.offset > 0); i++) {
            const para = allParas[i];
            if (!para) continue;
            const text = stripHeading(para.content);
            const from = i === start.paraIndex ? start.offset : 0;
            const to = i === end.paraIndex ? end.offset : text.length;
            if (to <= from) continue;
            fragments.push({ ...para, content: text.slice(from, to), sourceIdx: i, startOffset: from, endOffset: to, isPartialStart: from > 0, isPartialEnd: to < text.length });
        }
        setPageFragments(fragments);
        const visibleParas = fragments.map(f => allParas[f.sourceIdx]).filter(Boolean);
        setParagraphs(visibleParas);
        setComments(allComments);
        currentParaIdxRef.current = visibleParas[0]?.idx ?? null;
        const firstFragment = fragments[0];
        const charOffset = firstFragment && firstFragment.sourceIdx === start.paraIndex ? firstFragment.startOffset : 0;
        currentPositionRef.current = {
            page,
            paragraphIdx: visibleParas[0]?.idx ?? null,
            charOffset,
        };
        if (activeBook && visibleParas.length > 0 && !restoringProgressRef.current) {
            persistProgressPosition(activeBook.id, currentPositionRef.current);
        }
    }, [page, pageBreaks, allParas, allComments, activeBook?.id]);

    const goPage = (delta: number) => {
        if (!activeBook) return;
        const next = Math.max(1, Math.min(totalPages, page + delta));
        if (next !== page) {
            setFocusedThreadId(null); setReplyingTo(null); setCommentingIdx(null); setSelRange(null); setFloatingBar(null);
            setPage(next);
            if (next === totalPages && totalPages > 1) {
                const bookTitle = activeBook.title?.replace(/\s*\(.*?\)\s*/g, '').trim();
                fetch('/v1/reading-wishlist').then(r => r.json()).then(res => {
                    const match = (res.items || []).find((w: any) => w.status === 'reading' && w.title?.trim() === bookTitle);
                    if (match) {
                        fetch('/v1/reading-wishlist', {
                            method: 'POST', headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ id: match.id, title: match.title, author: match.author, reason: match.reason, status: 'done' }),
                        }).catch(() => {});
                    }
                }).catch(() => {});
            }
        }
    };

    const startAnnotation = () => {
        replyPageRef.current = page;
        if (!floatingBar) return;
        setSelRange({ startPara: floatingBar.startPara, endPara: floatingBar.endPara, start: floatingBar.start, end: floatingBar.end });
        setSelectedText(floatingBar.text);
        setCommentingIdx(floatingBar.startPara);
        setFloatingBar(null);
        window.getSelection()?.removeAllRanges();
    };

    const handleAddComment = async () => {
        if (!activeBook || commentingIdx === null || !commentText.trim()) return;
        try {
            const result = await api.addBookComment(activeBook.id, {
                paragraph_idx: commentingIdx, content: commentText.trim(), from_who: humanName,
                selected_text: selectedText || undefined,
                sel_start_idx: selRange ? selRange.start : undefined,
                sel_end_idx: selRange ? selRange.end : undefined,
                sel_end_para_idx: selRange && selRange.endPara !== selRange.startPara ? selRange.endPara : undefined,
                reply_to: replyingTo?.id || undefined,
            } as any);
            const newComment: Comment = {
                id: result?.id ?? Date.now(), book_id: activeBook.id, paragraph_idx: commentingIdx,
                sel_start_idx: selRange?.start ?? null, sel_end_idx: selRange?.end ?? null,
                sel_end_para_idx: selRange && selRange.endPara !== selRange.startPara ? selRange.endPara : null,
                selected_text: selectedText || null, from_who: humanName,
                content: commentText.trim(), created_at: new Date().toISOString(), reply_to: replyingTo?.id ?? null,
            };
            const pageToRestore = replyPageRef.current ?? page;
            replyPageRef.current = null;
            suppressPageJumpRef.current = true;
            setCommentText(''); setSelectedText(''); setSelRange(null); setReplyingTo(null);
            setCommentingIdx(null);
            setFocusedThreadId(replyingTo?.id ?? newComment.id);
            setComments(prev => [...prev, newComment]);
            setAllComments(prev => [...prev, newComment]);
            idbSetParas(`comments-v1-${activeBook.id}`, JSON.stringify([...allComments, newComment])).catch(() => {});
            setPage(pageToRestore);
            setTimeout(() => { suppressPageJumpRef.current = false; }, 500);
        } catch (e: any) { toast(`批注失败: ${e.message}`); }
    };

    const handleDeleteComment = async (cmt: Comment) => {
        try {
            await api.deleteBookComment(cmt.id);
            setComments(prev => prev.filter(x => x.id !== cmt.id));
            setAllComments(prev => prev.filter(x => x.id !== cmt.id));
            setFocusedThreadId(prev => prev === cmt.id ? null : prev);
            idbSetParas(`comments-v1-${activeBook.id}`, JSON.stringify(allComments.filter(x => x.id !== cmt.id))).catch(() => {});
        } catch (e: any) { toast(`删除失败: ${e.message}`); }
    };

    const currentReaderPosition = () => {
        const start = pageBreaks[page - 1] || { paraIndex: 0, offset: 0 };
        const derived = {
            page,
            paragraphIdx: allParas[start.paraIndex]?.idx ?? null,
            charOffset: start.offset,
        };
        return derived.paragraphIdx === null ? currentPositionRef.current : derived;
    };

    const saveBookmark = async () => {
        if (!activeBook) return;
        const position = currentReaderPosition();
        if (position.paragraphIdx === null) { toast('当前还没有可保存的阅读位置'); return; }
        try {
            const result = await api.updateBookBookmark(activeBook.id, {
                page: position.page,
                paragraph_idx: position.paragraphIdx,
                char_offset: position.charOffset,
            });
            setBookmark(result.bookmark || null);
            toast('书签已保存');
        } catch (e: any) { toast(`书签保存失败: ${e.message}`); }
    };

    const jumpToBookmark = () => {
        if (!bookmark) return;
        if (!canJumpToPara(bookmark.paragraph_idx)) return;
        const targetPage = findPageForParaIdx(bookmark.paragraph_idx, totalPages, bookmark.char_offset);
        setFocusedThreadId(null);
        setCommentingIdx(null);
        setSelRange(null);
        setFloatingBar(null);
        setPage(targetPage >= 0 ? targetPage + 1 : Math.max(1, Math.min(totalPages, bookmark.page)));
    };

    // 三个底栏弹层（书签菜单 / 字体面板 / 更多菜单）互斥，开一个收另外两个
    const toggleBookmarkMenu = () => { setShowBookmarkMenu(v => !v); setShowMoreMenu(false); setShowFontPanel(false); };
    const toggleFontPanel = () => { setShowFontPanel(v => !v); setShowBookmarkMenu(false); setShowMoreMenu(false); };
    const toggleMoreMenu = () => { setShowMoreMenu(v => !v); setShowBookmarkMenu(false); setShowFontPanel(false); };

    const handleExport = (format: 'epub' | 'md') => {
        if (!activeBook) return;
        setShowMoreMenu(false);
        window.open(coreadPath(`/v1/books/${activeBook.id}/export?format=${format}`), '_blank');
    };

    const jumpToChapter = (chapter: { idx: number; page: number; title: string }) => {
        if (!activeBook) return;
        const targetIdx = chapter.idx ?? chapter.page;
        if (!canJumpToPara(targetIdx)) return;
        setShowToc(false); setFocusedThreadId(null); setCommentingIdx(null); setSelRange(null); setFloatingBar(null);
        const targetPage = findPageForParaIdx(targetIdx);
        if (targetPage >= 0) setPage(targetPage + 1);
    };

    // 当前阅读位置所在章：最后一个起始页不超过当前页的章（目录要能定位当前章，不用从头划）
    const currentChapterIdx = useMemo(() => {
        let cur = -1;
        for (let i = 0; i < tocChapters.length; i++) {
            const ch = tocChapters[i];
            const pg = findPageForParaIdx(ch.idx ?? ch.page);
            if ((pg >= 0 ? pg + 1 : ch.page) <= page) cur = i;
            else break;
        }
        return cur;
    }, [tocChapters, page, pageBreaks, allParas]);

    // 打开目录时把当前章滚动到列表中央（窗口化后按钮按需渲染，不能scrollIntoView，直接算scrollTop）
    useEffect(() => {
        if (!showToc) return;
        const el = tocListRef.current;
        if (!el) return;
        setTocViewH(el.clientHeight);
        setTocScrollTop(el.scrollTop);
        if (currentChapterIdx >= 0) {
            const headerH = (el.firstElementChild as HTMLElement | null)?.offsetHeight ?? 0;
            el.scrollTop = Math.max(0, headerH + currentChapterIdx * TOC_ROW_H - el.clientHeight / 2);
        }
    }, [showToc, currentChapterIdx]);

    const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;
        const name = file.name.replace(/\.(pdf|txt|md|epub)$/i, '');
        if (!uploadTitle) setUploadTitle(name);
        setUploadFileName(file.name);
        const ext = file.name.toLowerCase().split('.').pop();

        if (ext === 'pdf' || ext === 'epub') {
            const reader = new FileReader();
            reader.onload = () => {
                const b64 = (reader.result as string).split(',')[1];
                setPdfBase64(b64); setUploadText('');
            };
            reader.readAsDataURL(file);
        } else {
            file.arrayBuffer().then(buf => {
                const bytes = new Uint8Array(buf);
                let text: string;
                try {
                    const utf8 = new TextDecoder('utf-8', { fatal: true });
                    text = utf8.decode(bytes);
                } catch {
                    const gbk = new TextDecoder('gbk');
                    text = gbk.decode(bytes);
                }
                setUploadText(text); setPdfBase64('');
            });
        }
    };

    const handleBatchUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const files = e.target.files;
        if (!files || files.length === 0) return;
        setUploading(true);
        let ok = 0, fail = 0;
        for (let i = 0; i < files.length; i++) {
            const file = files[i];
            const ext = file.name.toLowerCase().split('.').pop();
            if (!['epub', 'pdf', 'txt', 'md'].includes(ext || '')) { fail++; continue; }
            try {
                const title = file.name.replace(/\.(pdf|txt|md|epub)$/i, '');
                const b64 = await new Promise<string>((resolve) => {
                    const reader = new FileReader();
                    reader.onload = () => resolve((reader.result as string).split(',')[1]);
                    reader.readAsDataURL(file);
                });
                const payload: any = { title };
                if (ext === 'epub') { payload.format = 'epub'; payload.data = b64; }
                else if (ext === 'pdf') { payload.format = 'pdf'; payload.data = b64; }
                else { payload.content = atob(b64); }
                await api.createBook(payload);
                ok++;
                toast(`已上传 ${ok}/${files.length}: ${title}`);
            } catch { fail++; }
        }
        toast(fail ? `完成：${ok}成功，${fail}失败` : `全部${ok}本上传成功`);
        setUploading(false);
        setShowUpload(false);
        loadBooks();
        e.target.value = '';
    };

    const handleUpload = async () => {
        if (!uploadTitle.trim()) { toast('请输入书名'); return; }
        if (!uploadText && !pdfBase64) { toast('请选择文件或粘贴文本'); return; }
        setUploading(true);
        try {
            const payload: any = { title: uploadTitle.trim() };
            if (pdfBase64 && uploadFileName.toLowerCase().endsWith('.epub')) { payload.format = 'epub'; payload.data = pdfBase64; }
            else if (pdfBase64) { payload.format = 'pdf'; payload.data = pdfBase64; }
            else { payload.content = uploadText; }
            await api.createBook(payload);
            setShowUpload(false); setUploadTitle(''); setUploadText(''); setPdfBase64(''); setUploadFileName('');
            toast('上传成功');
            loadBooks();
        } catch (e: any) { toast(`上传失败: ${e.message}`); }
        setUploading(false);
    };

    const backToShelf = () => {
        const pending = persistCurrentPosition();
        setMode('shelf'); setActiveBook(null); setParagraphs([]); setComments([]);
        setFocusedThreadId(null); setReplyingTo(null); setCommentingIdx(null); setSelRange(null); setFloatingBar(null); setShowToc(false); setTocChapters([]);
        setBookmark(null); setReturnPoint(null);
        Promise.resolve(pending).finally(() => loadBooks());
    };

    // Morrow 外层有自己的 Page 头部返回箭头，不知道这里还分书架/阅读两层——
    // 把当前层级汇报给它，它才能在阅读中先退回书架，而不是直接把整个页面关掉。
    useEffect(() => {
        if (window.parent !== window) {
            window.parent.postMessage({ type: 'morrow-coread-mode', mode }, '*');
        }
    }, [mode]);
    useEffect(() => {
        if (window.parent === window) return;
        const onParentMessage = (e: MessageEvent) => {
            if (e.source !== window.parent) return;
            if (e.data?.type === 'morrow-coread-back' && mode === 'reading') backToShelf();
        };
        window.addEventListener('message', onParentMessage);
        return () => window.removeEventListener('message', onParentMessage);
    }, [mode]);

    const commentsForPara = (idx: number) => comments.filter(x => {
        if (x.sel_start_idx == null) return x.paragraph_idx === idx;
        const endPara = x.sel_end_para_idx ?? x.paragraph_idx;
        return x.paragraph_idx <= idx && idx <= endPara;
    });
    const stripHeading = (s: string) => s.replace(/^#+\s*/, '');
    const isHeading = (s: string) => s.trim().startsWith('#');
    const isChapterStart = (s: string) => {
        const trimmed = s.trim();
        const plain = stripHeading(trimmed).trim();
        const isChapter = /^(chapter|book|part|volume|prologue|epilogue)\b/i.test(plain)
            || /^\u7b2c[\d\s\w\u4e00-\u9fff]{1,20}[\u7ae0\u8282\u5377\u90e8\u7bc7\u56de]/.test(plain)
            || /^\u7b2c\d+\u7ae0/.test(trimmed);
        if (isChapter) return true;
        const heading = trimmed.match(/^(#{1,6})\s+/);
        return !!(heading && heading[1].length <= 2);
    };

    const renderHighlighted = (text: string, paraIdx: number, highlights: Comment[]) => {
        const positioned = highlights
            .filter(h => h.sel_start_idx != null && h.sel_end_idx != null && h.sel_start_idx! < text.length)
            .sort((a, b) => a.sel_start_idx! - b.sel_start_idx!);
        if (positioned.length === 0) return text;

        const parts: React.ReactNode[] = [];
        let lastEnd = 0;
        for (const h of positioned) {
            const start = Math.max(h.sel_start_idx!, lastEnd);
            const end = Math.min(h.sel_end_idx!, text.length);
            if (start >= end) continue;
            if (start > lastEnd) parts.push(<React.Fragment key={`t${paraIdx}-${lastEnd}`}>{text.slice(lastEnd, start)}</React.Fragment>);

            const isShen = h.from_who.toLowerCase() === 'ai' || h.from_who.toLowerCase() === aiName.toLowerCase();
            const hlBg = isShen ? c.shenHL : c.tongHL;
            const dotColor = isShen ? c.shenColor : c.tongColor;

            const showDot = h.paragraph_idx === paraIdx;
            const hStart = start, hEnd = end;
            parts.push(
                <span key={`h${h.id}-${paraIdx}`}
                    onClick={(e) => {
                        if (window.getSelection()?.toString().trim()) return;
                        e.stopPropagation();
                        const hit = positioned.find(x => {
                            const xs = Math.max(x.sel_start_idx!, 0), xe = Math.min(x.sel_end_idx!, text.length);
                            return xs < hEnd && xe > hStart;
                        });
                        const top = hit ? (hit.reply_to ?? hit.id) : null;
                        setFocusedThreadId(prev => prev === top ? null : top);
                    }}
                    style={{
                        backgroundImage: `linear-gradient(${hlBg}, ${hlBg})`,
                        backgroundRepeat: 'no-repeat',
                        backgroundSize: '100% 62%',
                        backgroundPosition: '0 72%',
                        borderRadius: 3,
                        position: 'relative',
                        cursor: 'pointer',
                        textDecorationLine: 'none',
                        padding: 0,
                        lineHeight: 'inherit',
                        boxDecorationBreak: 'clone',
                        WebkitBoxDecorationBreak: 'clone',
                    } as React.CSSProperties}>
                    {showDot && <span style={{ position: 'absolute', top: -2, left: -2, width: 7, height: 7, borderRadius: '50%', background: dotColor, boxShadow: `0 0 3px ${dotColor}60`, pointerEvents: 'none' }} />}
                    {text.slice(start, end)}
                </span>
            );
            lastEnd = end;
        }
        if (lastEnd < text.length) parts.push(<React.Fragment key={`t${paraIdx}-${lastEnd}`}>{text.slice(lastEnd)}</React.Fragment>);
        return <>{parts}</>;
    };

    const authorIsShen = (from: string) => from.toLowerCase() === 'ai' || from.toLowerCase() === aiName.toLowerCase();

    // 行间 thread：批注 + 回应写在对应原文下方的页边，两位作者用不同「笔迹」
    // （赭石=Resident / 青灰=用户 + 轻微缩进差），一眼可分，都不是聊天气泡。
    const renderThread = (root: Comment): React.ReactNode => {
        const kids = (parentId: number) =>
            comments.filter(r => r.reply_to === parentId).sort((a, b) => (a.created_at < b.created_at ? -1 : 1));
        let focused = focusedThreadId != null && focusedThreadId === root.id;
        if (focusedThreadId != null && !focused) {
            const stack = [root.id];
            while (stack.length) {
                const id = stack.pop()!;
                for (const k of kids(id)) { if (k.id === focusedThreadId) { focused = true; } stack.push(k.id); }
            }
        }
        const nightBody = readerNightMode ? READER_INK_NIGHT_SOFT : READER_INK_SOFT;

        const note = (cmt: Comment, depth: number): React.ReactNode => {
            const isShen = authorIsShen(cmt.from_who);
            const rail = isShen ? c.shenColor : c.tongColor;
            const tint = isShen ? c.shenBg : c.tongBg;
            return (
                <div key={cmt.id} style={{
                    marginLeft: (isShen ? 18 : 2) + depth * 16,
                    borderLeft: `2px solid ${rail}`,
                    background: tint,
                    borderRadius: '2px 8px 8px 2px',
                    padding: '7px 12px 8px',
                    marginBottom: 6,
                }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
                        <span style={{ width: 6, height: 6, borderRadius: '50%', background: rail, flexShrink: 0 }} />
                        <span style={{ fontSize: 11, fontWeight: 700, color: rail, letterSpacing: 0.2 }}>{displayName(cmt.from_who)}</span>
                        <span style={{ fontSize: 10, color: c.muted }}>{cmt.created_at?.slice(5, 16).replace('T', ' ')}</span>
                    </div>
                    {depth === 0 && cmt.selected_text && (
                        <div style={{ fontSize: 11, color: c.muted, lineHeight: 1.5, margin: '2px 0 5px', paddingLeft: 8, borderLeft: `2px solid ${rail}55` }}>
                            {cmt.selected_text.length > 120 ? cmt.selected_text.slice(0, 120) + '…' : cmt.selected_text}
                        </div>
                    )}
                    <div style={{ fontSize: Math.max(12, readerFontSize - 1), lineHeight: 1.7, color: nightBody, fontFamily: READER_SERIF, whiteSpace: 'pre-wrap' }}>{cmt.content}</div>
                    <div style={{ display: 'flex', gap: 12, marginTop: 4 }}>
                        <button onClick={(e) => { e.stopPropagation(); replyPageRef.current = page; setReplyingTo(cmt); setCommentingIdx(cmt.paragraph_idx); setCommentText(''); }}
                            style={{ background: 'none', border: 'none', padding: 0, fontSize: 11, color: c.muted, cursor: 'pointer' }}>回应</button>
                        {!isShen && (
                            <button onClick={(e) => { e.stopPropagation(); handleDeleteComment(cmt); }}
                                style={{ background: 'none', border: 'none', padding: 0, fontSize: 11, color: c.muted, cursor: 'pointer' }}>删除</button>
                        )}
                    </div>
                    {replyingTo?.id === cmt.id && (
                        <div style={{ display: 'flex', gap: 6, marginTop: 6 }} onClick={(e) => e.stopPropagation()}>
                            <input autoFocus value={commentText} onChange={e => setCommentText(e.target.value)} placeholder="写回应…"
                                onKeyDown={e => { if (e.key === 'Enter') handleAddComment(); }}
                                style={{ flex: 1, border: `1px solid ${c.primaryBorder}`, borderRadius: 8, padding: '5px 10px', fontSize: 12, outline: 'none', background: readerNightMode ? 'rgba(255,255,255,0.06)' : '#fff', color: nightBody }} />
                            <button onClick={handleAddComment} disabled={!commentText.trim()} aria-label="发送回应" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, width: 28, height: 28, background: c.primary, border: 'none', borderRadius: '50%', cursor: commentText.trim() ? 'pointer' : 'default', opacity: commentText.trim() ? 1 : 0.5 }}>
                                <SendIcon color="#fff" size={13} />
                            </button>
                            <button onClick={() => { setReplyingTo(null); setCommentText(''); }} style={{ background: 'none', border: 'none', padding: '5px 6px', fontSize: 14, color: c.muted, cursor: 'pointer', flexShrink: 0 }}>×</button>
                        </div>
                    )}
                    {kids(cmt.id).map(k => note(k, depth + 1))}
                </div>
            );
        };

        return (
            <div key={`thread-${root.id}`} data-thread-anchor={root.id} style={{
                margin: `4px 0 ${PARA_GAP}px`,
                borderRadius: 8,
                outline: focused ? `1.5px solid ${c.primary}66` : '1.5px solid transparent',
                outlineOffset: 3,
                transition: 'outline-color 220ms ease',
            }}>
                {note(root, 0)}
            </div>
        );
    };

    const btnBase: React.CSSProperties = {
        background: 'rgba(255,255,255,0.6)', backdropFilter: 'blur(18px) saturate(1.05)',
        WebkitBackdropFilter: 'blur(18px) saturate(1.05)',
        border: `1px solid ${c.primaryBorder}`, borderRadius: 14,
        width: 36, height: 36, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer',
    };

    // 书架 action row 四个按钮共用一套线性 SVG——尺寸、线宽统一，不再混用文字/emoji/Unicode
    // 符号（vv 2026-09-05 反馈）。
    const ACTION_ICON_SIZE = 18;
    const ACTION_ICON_STROKE = 1.8;
    const actionSvgProps = (color: string) => ({
        width: ACTION_ICON_SIZE, height: ACTION_ICON_SIZE, viewBox: '0 0 24 24',
        fill: 'none' as const, stroke: color, strokeWidth: ACTION_ICON_STROKE,
        strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const,
    });
    const BindIcon = ({ color }: { color: string }) => (
        <svg {...actionSvgProps(color)}><path d="M21 11.5a8.5 8.5 0 0 1-8.5 8.5 8.4 8.4 0 0 1-4-.97L3 20l1.46-4.38A8.4 8.4 0 0 1 3.5 11.5 8.5 8.5 0 0 1 12 3a8.5 8.5 0 0 1 9 8.5Z" /></svg>
    );
    const EditIcon = ({ color }: { color: string }) => (
        <svg {...actionSvgProps(color)}><path d="M12 20h9" /><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" /></svg>
    );
    const CheckIcon = ({ color }: { color: string }) => (
        <svg {...actionSvgProps(color)}><path d="M20 6 9 17l-5-5" /></svg>
    );
    const SlidersIcon = ({ color }: { color: string }) => (
        <svg {...actionSvgProps(color)}>
            <line x1="4" y1="6" x2="20" y2="6" /><circle cx="14" cy="6" r="2" fill={color} stroke="none" />
            <line x1="4" y1="12" x2="20" y2="12" /><circle cx="8" cy="12" r="2" fill={color} stroke="none" />
            <line x1="4" y1="18" x2="20" y2="18" /><circle cx="16" cy="18" r="2" fill={color} stroke="none" />
        </svg>
    );
    const PlusIcon = ({ color }: { color: string }) => (
        <svg {...actionSvgProps(color)}><path d="M12 5v14" /><path d="M5 12h14" /></svg>
    );
    const TrashIcon = ({ color }: { color: string }) => (
        <svg {...actionSvgProps(color)}>
            <path d="M3 6h18" /><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
            <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
            <line x1="10" y1="11" x2="10" y2="17" /><line x1="14" y1="11" x2="14" y2="17" />
        </svg>
    );
    // 批注体系统一图标：写批注入口用线性 pencil，保存/发送统一用纸飞机——
    // 两处不再各写各的文字按钮。
    const AnnotationIcon = ({ color, size = 15 }: { color: string; size?: number }) => (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 20h9" /><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
        </svg>
    );
    const SendIcon = ({ color, size = 15 }: { color: string; size?: number }) => (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
            <line x1="22" y1="2" x2="11" y2="13" /><polygon points="22 2 15 22 11 13 2 9 22 2" />
        </svg>
    );

    return (
        <div className="xiaowo-study" style={{ height: '100%', width: '100%', display: 'flex', flexDirection: 'column', background: mode === 'reading' ? (readerNightMode ? PAPER_BG_NIGHT : PAPER_BG) : '#f8f8f6', position: 'relative', overflow: 'hidden', filter: mode === 'reading' && readerBrightness < 100 ? `brightness(${readerBrightness / 100})` : undefined }}>
            <style>{`${STUDY_THEME_CSS}\n@keyframes pulse { 0%,100% { transform: scale(1); } 50% { transform: scale(1.04); } }`}</style>
            {/* Header — shelf always shows; reading mode header slides with toolbar */}
            {mode === 'shelf' ? (
                // 外层 Morrow Page 头部已经管标题和返回（2026-09-05 改版）；这里只剩紧贴
                // 在它下面的轻量 action row，不再自带返回键/标题/大顶距。
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 10, paddingTop: 12, paddingLeft: 20, paddingRight: 20, paddingBottom: 12, flexShrink: 0 }}>
                    <button onClick={openBindingPicker} style={btnBase} aria-label="绑定会话">
                        <BindIcon color={c.primary} />
                    </button>
                    {editMode && selectedBooks.size > 0 && (
                        <button onClick={async () => {
                            if (!confirm(`删除选中的 ${selectedBooks.size} 本书？`)) return;
                            for (const id of selectedBooks) {
                                try {
                                    await api.deleteBook(id);
                                    try { localStorage.removeItem(`pagebreaks-v3-${id}`); } catch {}
                                    idbDel(`pagebreaks-v3-${id}`);
                                    idbDelParas(`paras-v1-${id}`);
                                    idbDelParas(`comments-v1-${id}`);
                                } catch {}
                            }
                            setSelectedBooks(new Set()); setEditMode(false); loadBooks();
                            toast(`已删除 ${selectedBooks.size} 本`);
                        }} style={{ ...btnBase, background: '#e55', border: 'none' }} aria-label={`删除选中的${selectedBooks.size}本`}>
                            <TrashIcon color="white" />
                        </button>
                    )}
                    <button onClick={() => { setEditMode(!editMode); setSelectedBooks(new Set()); }} style={btnBase} aria-label={editMode ? '完成管理' : '管理'}>
                        {editMode ? <CheckIcon color={c.primary} /> : <EditIcon color={c.primary} />}
                    </button>
                    <button onClick={() => setShowSettings(true)} style={btnBase} aria-label="设置">
                        <SlidersIcon color={c.primary} />
                    </button>
                    <button onClick={() => setShowUpload(true)} style={btnBase} aria-label="添加">
                        <PlusIcon color={c.primary} />
                    </button>
                </div>
            ) : (
                <>
                    {/* Persistent book title — always visible, small grey text */}
                    <div style={{
                        paddingTop: 'calc(12px + env(safe-area-inset-top))', paddingLeft: 20, paddingRight: 20, paddingBottom: 6, textAlign: 'center', flexShrink: 0,
                        background: readerNightMode ? PAPER_BG_NIGHT : PAPER_BG,
                    }}>
                        <div style={{ fontSize: 11, color: readerNightMode ? '#7a736a' : '#a8a196', letterSpacing: 0.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {activeBook?.title || ''}
                        </div>
                    </div>
                    {/* Sliding exit button — top right, only shows with toolbar */}
                    <div style={{
                        position: 'absolute', top: 44, right: 12, zIndex: 15,
                        opacity: showBar ? 1 : 0, transform: showBar ? 'translateY(0)' : 'translateY(-20px)',
                        transition: 'opacity 0.3s ease, transform 0.3s ease',
                        pointerEvents: showBar ? 'auto' : 'none',
                    }}>
                        <button onClick={backToShelf} style={btnBase}>
                            <span style={{ fontSize: 16, color: c.primary }}>✕</span>
                        </button>
                    </div>
                </>
            )}

            {/* Content */}
            <div ref={contentRef} style={{
                flex: 1, position: 'relative',
                overflowX: 'hidden', overflowY: 'auto',
                padding: mode === 'reading' ? '0' : '8px 20px 32px',
                background: mode === 'reading' ? (readerNightMode ? PAPER_BG_NIGHT : PAPER_BG) : 'transparent',
            }} className="no-scrollbar study-scroll-container"
                onClick={() => { if (mode === 'reading') toggleBar(); else if (focusedThreadId != null) setFocusedThreadId(null); }}
                onTouchStart={mode === 'reading' ? (e) => {
                    touchStart.current = { x: e.touches[0].clientX, y: e.touches[0].clientY, t: Date.now() };
                } : undefined}
                onTouchEnd={mode === 'reading' ? (e) => {
                    if (!touchStart.current) return;
                    const dx = e.changedTouches[0].clientX - touchStart.current.x;
                    const dy = e.changedTouches[0].clientY - touchStart.current.y;
                    const dt = Date.now() - touchStart.current.t;
                    touchStart.current = null;
                    if (dt > 500 || Math.abs(dy) > Math.abs(dx) || Math.abs(dx) < 60) return;
                    if (dx < -60) goPage(1);
                    else if (dx > 60) goPage(-1);
                } : undefined}>

                {loading ? (
                    <div style={{ textAlign: 'center', padding: '60px 0', color: '#bbb', fontSize: 14 }}>加载中...</div>
                ) : error ? (
                    <div style={{ textAlign: 'center', padding: '60px 20px' }}>
                        <div style={{ fontSize: 13, color: '#e88', marginBottom: 12 }}>{error}</div>
                        <button onClick={loadBooks} style={{ background: 'none', border: `1px solid ${c.primaryBorder}`, borderRadius: 12, padding: '8px 20px', fontSize: 12, color: c.primary, cursor: 'pointer' }}>重试</button>
                    </div>
                ) : mode === 'shelf' ? (
                    <>
                        {books.length === 0 ? (
                            <div style={{ textAlign: 'center', padding: '60px 20px', color: '#bbb' }}>
                                <div style={{ width: 56, height: 56, borderRadius: '50%', background: `linear-gradient(135deg, ${c.primaryLight}, ${c.warmBg})`, margin: '0 auto 16px' }} />
                                <div style={{ fontSize: 14, marginBottom: 6 }}>书架空空的</div>
                                <div style={{ fontSize: 12, color: '#ccc' }}>点右上角 + 上传一本书</div>
                            </div>
                        ) : (
                            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}>
                                {[...books].sort((a, b) => {
                                    const aTime = a.last_read_at ? new Date(a.last_read_at).getTime() : 0;
                                    const bTime = b.last_read_at ? new Date(b.last_read_at).getTime() : 0;
                                    if (aTime || bTime) { if (aTime !== bTime) return bTime - aTime; }
                                    return b.id - a.id;
                                }).map((book, i) => {
                                    const progress = book.current_page != null && book.total_paragraphs > 0
                                        ? Math.round(((book.current_page + 1) / book.total_paragraphs) * 100) : 0;
                                    return (
                                        <div key={book.id} style={{ position: 'relative' }}>
                                            <button onClick={() => {
                                                if (editMode) {
                                                    setSelectedBooks(prev => { const s = new Set(prev); s.has(book.id) ? s.delete(book.id) : s.add(book.id); return s; });
                                                } else openBook(book);
                                            }} style={{
                                                background: 'none', padding: 0, border: 'none', cursor: 'pointer',
                                                textAlign: 'left', display: 'flex', flexDirection: 'column', width: '100%',
                                            }}>
                                                <div style={{ width: '100%', aspectRatio: '2/3', borderRadius: '4px 12px 12px 4px', overflow: 'hidden', position: 'relative', background: book.cover_image ? '#f0ebe3' : BOOK_COVERS[i % BOOK_COVERS.length], display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '3px 3px 12px rgba(0,0,0,0.18), inset -2px 0 4px rgba(0,0,0,0.05)', borderLeft: `4px solid ${book.cover_image ? 'rgba(0,0,0,0.12)' : 'rgba(0,0,0,0.08)'}`, opacity: editMode && selectedBooks.has(book.id) ? 0.6 : 1 }}>
                                                    {editMode && (
                                                        <div style={{ position: 'absolute', top: 6, left: 8, width: 22, height: 22, borderRadius: '50%', background: selectedBooks.has(book.id) ? c.primary : 'rgba(255,255,255,0.7)', border: `2px solid ${selectedBooks.has(book.id) ? c.primary : 'rgba(0,0,0,0.2)'}`, zIndex: 2, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                                                            {selectedBooks.has(book.id) && <span style={{ color: 'white', fontSize: 14, fontWeight: 700 }}>✓</span>}
                                                        </div>
                                                    )}
                                                    {book.cover_image ? (
                                                        <img src={api.imageUrl(book.id, book.cover_image)} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                                                    ) : (
                                                        <span style={{ fontSize: 22, fontWeight: 800, color: 'rgba(82,74,96,0.36)', padding: 8, textAlign: 'center', lineHeight: 1.3, wordBreak: 'break-all' }}>{book.title.slice(0, 4)}</span>
                                                    )}
                                                    {book.comment_count > 0 && (
                                                        <div style={{ position: 'absolute', top: 6, right: 6, background: 'rgba(255,255,255,0.8)', borderRadius: 8, padding: '1px 6px', fontSize: 9, fontWeight: 700, color: c.primaryDark }}>
                                                            {book.comment_count}
                                                        </div>
                                                    )}
                                                    {progress > 0 && (
                                                        <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, height: 3, background: 'rgba(0,0,0,0.1)' }}>
                                                            <div style={{ height: '100%', width: `${Math.min(progress, 100)}%`, background: c.primary, borderRadius: '0 2px 2px 0' }} />
                                                        </div>
                                                    )}
                                                </div>
                                                <div style={{ padding: '8px 2px 0', overflow: 'hidden' }}>
                                                    <div style={{ fontSize: 11, fontWeight: 600, color: c.primaryDark, lineHeight: 1.3, overflow: 'hidden', textOverflow: 'ellipsis', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' } as any}>{book.title}</div>
                                                </div>
                                            </button>
                                        </div>
                                    );
                                })}
                            </div>
                        )}
                    </>
                ) : (
                    /* Reading Mode — immersive, no card border */
                    <>
                        {readingLoading ? (
                            <div style={{ textAlign: 'center', padding: '40px 20px', color: '#bbb', fontSize: 14 }}>
                                {paginateProgress != null ? (
                                    <>
                                        <div style={{ marginBottom: 12 }}>大书首次打开需要分页一次，之后秒开</div>
                                        <div style={{ width: 180, height: 4, borderRadius: 2, background: `${c.primary}18`, margin: '0 auto 8px', overflow: 'hidden' }}>
                                            <div style={{ height: '100%', borderRadius: 2, width: `${Math.round(paginateProgress * 100)}%`, background: c.primary, transition: 'width 0.2s ease' }} />
                                        </div>
                                        <div style={{ fontSize: 12, color: '#ccc' }}>{Math.round(paginateProgress * 100)}%</div>
                                    </>
                                ) : '加载中...'}
                            </div>
                        ) : allParas.length === 0 ? (
                            <div style={{ textAlign: 'center', padding: '40px 0', color: '#bbb', fontSize: 14 }}>这一页没有内容</div>
                        ) : (
                            <div data-page-content style={{ padding: READER_PAGE_PADDING, paddingBottom: 'calc(44px + env(safe-area-inset-bottom))', minHeight: pageHeight || undefined, boxSizing: 'border-box', fontFamily: READER_SERIF }}>
                                {(() => {
                                const seenThreadIds = new Set<number>();
                                return pageFragments.map((frag, visibleIndex) => {
                                    const original = allParas[frag.sourceIdx] || frag;
                                    const heading = isHeading(original.content) && !frag.isPartialStart;
                                    const chapterTitle = isChapterStart(original.content) && !frag.isPartialStart;
                                    const rawInline = commentsForPara(frag.idx).filter(x => x.sel_start_idx != null && x.sel_end_idx != null);
                                    const inlineComments = rawInline.map(h => {
                                        const endPara = h.sel_end_para_idx ?? h.paragraph_idx;
                                        let s = h.sel_start_idx!, e = h.sel_end_idx!;
                                        if (h.paragraph_idx === frag.idx && endPara === frag.idx) { /* single para */ }
                                        else if (h.paragraph_idx === frag.idx) { e = frag.endOffset; }
                                        else if (endPara === frag.idx) { s = frag.startOffset; }
                                        else { s = frag.startOffset; e = frag.endOffset; }
                                        return { ...h, sel_start_idx: s - frag.startOffset, sel_end_idx: e - frag.startOffset };
                                    }).filter(h => h.sel_end_idx! > 0 && h.sel_start_idx! < frag.content.length);

                                    // 行间 thread：本 fragment 上、尚未渲染过的顶层批注（含无选区的整段批注）。
                                    const fragThreads = commentsForPara(frag.idx).filter(x => !x.reply_to && !seenThreadIds.has(x.id));
                                    fragThreads.forEach(x => seenThreadIds.add(x.id));

                                    const imgMatch = frag.content.match(/^\[IMG:([^\]]+)\]$/);
                                    if (imgMatch && activeBook) {
                                        const imgUrl = api.imageUrl(activeBook.id, imgMatch[1]);
                                        return (
                                            <div key={`${frag.idx}-${frag.startOffset}-${frag.endOffset}`} style={{ marginBottom: PARA_GAP, textAlign: 'center' }}>
                                                <img src={imgUrl} alt="" style={{ maxWidth: '100%', maxHeight: `${Math.floor(readerSize.height * 0.6)}px`, objectFit: 'contain', display: 'block', margin: '0 auto', borderRadius: 8 }} />
                                            </div>
                                        );
                                    }
                                    return (
                                        <div key={`${frag.idx}-${frag.startOffset}-${frag.endOffset}`} style={{ marginBottom: chapterTitle ? CHAPTER_GAP_BOTTOM : PARA_GAP, marginTop: chapterTitle && visibleIndex > 0 ? CHAPTER_GAP_TOP : 0 }}>
                                            <div data-para-idx={frag.idx} data-frag-start={frag.startOffset} data-frag-end={frag.endOffset} style={{
                                                fontSize: chapterTitle ? readerFontSize + 4 : original.content.trim().startsWith('# ') ? readerFontSize + 3 : original.content.trim().startsWith('## ') ? readerFontSize + 2 : readerFontSize,
                                                lineHeight: chapterTitle ? 2.2 : 1.85,
                                                color: readerNightMode ? (heading ? READER_INK_NIGHT : READER_INK_NIGHT_SOFT) : (heading ? '#2c2921' : READER_INK),
                                                letterSpacing: chapterTitle ? 1 : 0.3, textIndent: (heading || chapterTitle || frag.isPartialStart) ? 0 : '1.5em',
                                                fontWeight: chapterTitle ? 800 : heading ? 700 : 400, marginBottom: heading ? 4 : 0,
                                                textAlign: chapterTitle ? 'center' : undefined,
                                                fontFamily: READER_SERIF,
                                                userSelect: 'text', WebkitUserSelect: 'text', whiteSpace: 'pre-wrap',
                                            } as any}>
                                                {renderHighlighted(decodeEntities(frag.content), frag.idx, inlineComments)}
                                            </div>

                                            {fragThreads.length > 0 && (
                                                <div style={{ marginTop: 8 }}>
                                                    {fragThreads.map(cmt => renderThread(cmt))}
                                                </div>
                                            )}
                                        </div>
                                    );
                                });
                                })()}
                            </div>
                        )}
                    </>
                )}
                {mode === 'reading' && (
                    <div ref={measureRef} aria-hidden style={{
                        position: 'fixed',
                        top: 0,
                        left: 0,
                        width: readerContentWidth,
                        visibility: 'hidden',
                        pointerEvents: 'none',
                        zIndex: -1,
                        boxSizing: 'border-box',
                        whiteSpace: 'normal',
                        fontFamily: READER_SERIF,
                    }} />
                )}

            </div>

            {/* 选区底部操作条 — 不再锚在选区上方（会被 Android/Chrome 原生长按菜单和选择手柄
                挡住、点不到），改成固定在屏幕底部、阅读工具栏上方；原生长按选词/选择手柄/
                复制/全选完全不受影响。 */}
            {floatingBar && mode === 'reading' && commentingIdx === null && (
                <div style={{
                    position: 'absolute', left: 0, right: 0, zIndex: 34,
                    bottom: showBar ? 106 : 30,
                    display: 'flex', justifyContent: 'center',
                    transition: 'bottom 0.3s ease',
                    pointerEvents: 'none',
                }}>
                    <button onPointerDown={(e) => { e.preventDefault(); startAnnotation(); }} style={{
                        display: 'flex', alignItems: 'center', gap: 7, pointerEvents: 'auto',
                        background: readerNightMode ? '#302d27' : '#fff',
                        color: readerNightMode ? READER_INK_NIGHT : READER_INK,
                        border: `1px solid ${c.primaryBorder}`, borderRadius: 22,
                        padding: '9px 18px', fontSize: 13, fontWeight: 600,
                        boxShadow: '0 4px 18px rgba(0,0,0,0.18)', cursor: 'pointer', whiteSpace: 'nowrap',
                    }}>
                        <AnnotationIcon color={c.primary} size={15} />
                        写批注
                    </button>
                </div>
            )}

            {/* 新建批注编辑框 — 安静的纸面卡片，不抢正文 */}
            {mode === 'reading' && commentingIdx !== null && !replyingTo && (
                <div onClick={(e) => e.stopPropagation()} style={{
                    position: 'absolute', left: 16, right: 16, bottom: 20, zIndex: 32,
                    background: readerNightMode ? '#2b2924' : '#fff',
                    borderRadius: 14, padding: 14, border: `1px solid ${c.primaryBorder}`,
                    boxShadow: '0 -2px 24px rgba(0,0,0,0.10)',
                }}>
                    {selectedText && (
                        <div style={{ fontSize: 12, color: c.muted, marginBottom: 10, padding: '7px 10px', background: c.tongBg, borderRadius: 8, lineHeight: 1.5, borderLeft: `2px solid ${c.tongColor}`, maxHeight: 96, overflow: 'auto' }} className="no-scrollbar">
                            {selectedText.length > 160 ? selectedText.slice(0, 160) + '…' : selectedText}
                        </div>
                    )}
                    <textarea value={commentText} onChange={e => setCommentText(e.target.value)} placeholder="写下你的想法…"
                        style={{ width: '100%', minHeight: 68, border: 'none', background: 'transparent', fontSize: 14, color: readerNightMode ? READER_INK_NIGHT_SOFT : READER_INK_SOFT, resize: 'none', outline: 'none', lineHeight: 1.6, fontFamily: READER_SERIF }} autoFocus />
                    <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 8 }}>
                        <button onClick={() => { setCommentingIdx(null); setCommentText(''); setSelectedText(''); setSelRange(null); }}
                            style={{ background: 'none', border: 'none', padding: '7px 10px', fontSize: 12, color: c.muted, cursor: 'pointer' }}>取消</button>
                        <button onClick={handleAddComment} disabled={!commentText.trim()} aria-label="保存批注"
                            style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 34, height: 34, background: c.primary, border: 'none', borderRadius: '50%', cursor: commentText.trim() ? 'pointer' : 'default', opacity: commentText.trim() ? 1 : 0.5 }}>
                            <SendIcon color="#fff" size={15} />
                        </button>
                    </div>
                </div>
            )}

            {mode === 'reading' && returnPoint && (
                <button onClick={(e) => { e.stopPropagation(); returnToReadingPosition(); }} style={{
                    position: 'absolute', top: 44, left: 12, zIndex: 28,
                    background: 'rgba(255,255,255,0.94)', backdropFilter: 'blur(16px)',
                    border: `1px solid ${c.primaryBorder}`, borderRadius: 16,
                    padding: '7px 12px', color: c.primary, fontSize: 12, fontWeight: 700,
                    boxShadow: '0 4px 18px rgba(0,0,0,0.08)', cursor: 'pointer',
                }}>
                    返回阅读位置
                </button>
            )}

            {/* New replies notification bubble */}
            {mode === 'reading' && newReplies.length > 0 && !showReplies && (
                <div onClick={(e) => { e.stopPropagation(); setShowReplies(true); }} style={{
                    position: 'absolute', bottom: showBar ? 72 : 22, right: 16, zIndex: 30,
                    background: c.shenColor, borderRadius: 20, padding: '8px 14px',
                    boxShadow: '0 4px 16px rgba(0,0,0,0.15)', cursor: 'pointer',
                    display: 'flex', alignItems: 'center', gap: 6,
                    animation: 'pulse 2s ease-in-out infinite',
                    transition: 'bottom 0.3s ease',
                }}>
                    <span style={{ color: '#fff', fontSize: 12, fontWeight: 600 }}>CC · {newReplies.length} 条新互动</span>
                </div>
            )}

            {/* New replies panel */}
            {showReplies && newReplies.length > 0 && (
                <div onClick={(e) => e.stopPropagation()} style={{
                    position: 'absolute', bottom: 20, right: 16, left: 16, zIndex: 30,
                    background: 'rgba(255,255,255,0.97)', backdropFilter: 'blur(24px)',
                    borderRadius: 20, padding: '16px 18px', border: `1px solid ${c.primaryBorder}`,
                    boxShadow: '0 -4px 32px rgba(0,0,0,0.1)', maxHeight: '55vh', overflow: 'auto',
                }} className="no-scrollbar">
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
                        <span style={{ fontSize: 14, fontWeight: 700, color: c.shenColor }}>最新批注回复</span>
                        <div style={{ display: 'flex', gap: 8 }}>
                            <button onClick={dismissReplies} style={{ background: c.primaryBg, border: `1px solid ${c.primaryBorder}`, borderRadius: 12, padding: '5px 14px', fontSize: 11, color: '#999', cursor: 'pointer' }}>已读</button>
                            <button onClick={() => setShowReplies(false)} style={{ background: c.primaryBg, border: `1px solid ${c.primaryBorder}`, borderRadius: 12, padding: '5px 14px', fontSize: 11, color: '#999', cursor: 'pointer' }}>收起</button>
                        </div>
                    </div>
                    {newReplies.map(r => (
                        <div key={r.id} onClick={() => openReplyNotice(r)} style={{ marginBottom: 14, paddingBottom: 12, borderBottom: `1px solid ${c.primaryBorder}`, cursor: 'pointer' }}>
                            {r.parent_content && (
                                <div style={{ fontSize: 11, color: '#aaa', marginBottom: 6, padding: '4px 10px', background: c.tongBg, borderRadius: 8, borderLeft: `3px solid ${c.tongColor}` }}>
                                    {r.parent_from}: {r.parent_content.length > 40 ? r.parent_content.slice(0, 40) + '...' : r.parent_content}
                                </div>
                            )}
                            <div style={{ fontSize: 13, color: '#444', lineHeight: 1.6 }}>{r.content}</div>
                            <div style={{ fontSize: 10, color: '#aaa', marginTop: 4 }}>{(() => { const pg = findPageForParaIdx(r.paragraph_idx, totalPages, r.sel_start_idx ?? 0); return pg >= 0 ? `p${pg + 1}` : `p${r.paragraph_idx}`; })()} · 点开定位到原文</div>
                        </div>
                    ))}
                </div>
            )}

            {/* Bottom toolbar — iOS Books style, slides up on tap */}
            {mode === 'reading' && (
                <>
                    {/* Page number — always visible at bottom center */}
                    <div style={{
                        position: 'absolute', bottom: showBar ? 62 : 12, left: 0, right: 0,
                        textAlign: 'center', fontSize: 11, color: '#bbb', zIndex: 5,
                        transition: 'bottom 0.3s ease', pointerEvents: 'none',
                    }}>
                        {page}
                    </div>

                    {/* Sliding bottom bar */}
                    <div onClick={(e) => e.stopPropagation()} style={{
                        position: 'absolute', bottom: 0, left: 0, right: 0, zIndex: 15,
                        background: readerNightMode ? 'rgba(30,30,30,0.95)' : 'rgba(255,255,255,0.95)', backdropFilter: 'blur(16px)',
                        borderTop: `1px solid ${readerNightMode ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)'}`,
                        padding: '10px 20px 22px',
                        transform: showBar ? 'translateY(0)' : 'translateY(100%)',
                        transition: 'transform 0.3s ease',
                    }}>
                        {/* Progress slider row */}
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
                            <button onClick={() => goPage(-1)} disabled={page <= 1}
                                style={{ background: 'none', border: 'none', fontSize: 18, color: page > 1 ? c.primary : '#ddd', cursor: 'pointer', padding: '2px 4px' }}>‹</button>
                            <div style={{ flex: 1, height: 3, borderRadius: 2, background: `${c.primary}18`, position: 'relative', overflow: 'hidden' }}>
                                <div style={{
                                    position: 'absolute', left: 0, top: 0, height: '100%', borderRadius: 2,
                                    width: `${totalPages > 1 ? ((page - 1) / (totalPages - 1)) * 100 : 100}%`,
                                    background: c.primary, transition: 'width 0.3s ease',
                                }} />
                            </div>
                            <button onClick={() => goPage(1)} disabled={page >= totalPages}
                                style={{ background: 'none', border: 'none', fontSize: 18, color: page < totalPages ? c.primary : '#ddd', cursor: 'pointer', padding: '2px 4px' }}>›</button>
                        </div>
                        {/* Bottom row: 页码 ｜ 书签 ｜ Aa ｜ 目录 ｜ ··· — 五项等宽分布，手机宽度不挤 */}
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1, padding: '2px 6px' }}>
                                <span style={{ fontSize: 12, lineHeight: 1, color: '#aaa' }}>{page}/{totalPages}</span>
                                <span style={{ fontSize: 9, color: '#aaa' }}>页码</span>
                            </div>
                            <button onClick={toggleBookmarkMenu} aria-label="书签"
                                style={{ flex: 1, background: 'none', border: 'none', cursor: 'pointer', padding: '2px 6px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1 }}>
                                <span style={{ fontSize: 15, lineHeight: 1, color: (bookmark || showBookmarkMenu) ? c.primary : '#666' }}>{bookmark ? '★' : '☆'}</span>
                                <span style={{ fontSize: 9, color: (bookmark || showBookmarkMenu) ? c.primary : '#aaa' }}>书签</span>
                            </button>
                            <button onClick={toggleFontPanel} aria-label="字体与显示设置"
                                style={{ flex: 1, background: 'none', border: 'none', cursor: 'pointer', padding: '2px 6px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1 }}>
                                <span style={{ fontSize: 14, lineHeight: 1, color: showFontPanel ? c.primary : '#666', fontWeight: 700, fontFamily: 'serif' }}>Aa</span>
                                <span style={{ fontSize: 9, color: showFontPanel ? c.primary : '#aaa' }}>字体</span>
                            </button>
                            <button onClick={() => setShowToc(true)} aria-label="目录"
                                style={{ flex: 1, background: 'none', border: 'none', cursor: 'pointer', padding: '2px 6px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1 }}>
                                <span style={{ fontSize: 15, lineHeight: 1, color: '#666' }}>☰</span>
                                <span style={{ fontSize: 9, color: '#aaa' }}>目录</span>
                            </button>
                            <button onClick={toggleMoreMenu} aria-label="更多操作"
                                style={{ flex: 1, background: 'none', border: 'none', cursor: 'pointer', padding: '2px 6px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1 }}>
                                <span style={{ fontSize: 15, lineHeight: 1, color: showMoreMenu ? c.primary : '#666' }}>···</span>
                                <span style={{ fontSize: 9, color: showMoreMenu ? c.primary : '#aaa' }}>更多</span>
                            </button>
                        </div>
                    </div>

                    {/* Reading settings panel — brightness, font size, night mode, 上下文范围 */}
                    <div onClick={(e) => e.stopPropagation()} className="no-scrollbar" style={{
                        position: 'absolute', bottom: showBar ? 90 : -400, left: 16, right: 16, zIndex: 20,
                        background: readerNightMode ? '#2b2924' : '#fff',
                        borderRadius: 16, padding: '18px 20px', maxHeight: '68vh', overflowY: 'auto',
                        boxShadow: '0 -2px 24px rgba(0,0,0,0.10)', border: `1px solid ${c.primaryBorder}`,
                        opacity: showFontPanel && showBar ? 1 : 0,
                        transform: showFontPanel && showBar ? 'translateY(0)' : 'translateY(20px)',
                        transition: 'opacity 0.25s ease, transform 0.25s ease, bottom 0.3s ease',
                        pointerEvents: showFontPanel && showBar ? 'auto' : 'none',
                    }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
                            <span style={{ fontSize: 13, color: readerNightMode ? '#666' : '#bbb', lineHeight: 1 }}>☀</span>
                            <input type="range" min={30} max={100} step={1} value={readerBrightness}
                                onChange={e => { const v = parseInt(e.target.value, 10); setReaderBrightness(v); localStorage.setItem('coread-brightness', String(v)); }}
                                style={{ flex: 1, accentColor: c.primary, height: 4 }} />
                            <span style={{ fontSize: 16, color: readerNightMode ? '#888' : '#999', lineHeight: 1 }}>☀</span>
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 14, borderRadius: 8, overflow: 'hidden', border: `1px solid ${readerNightMode ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.08)'}` }}>
                            <button onClick={() => { const v = Math.max(12, readerFontSize - 1); setReaderFontSize(v); localStorage.setItem('coread-font-size', String(v)); }}
                                style={{ flex: 1, padding: '8px 0', background: 'none', border: 'none', borderRight: `1px solid ${readerNightMode ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.08)'}`, cursor: 'pointer', fontSize: 13, fontFamily: 'serif', color: readerNightMode ? '#aaa' : '#666' }}>
                                A<span style={{ fontSize: 9, verticalAlign: 'super' }}>−</span>
                            </button>
                            <span style={{ padding: '8px 14px', fontSize: 12, color: c.primary, fontWeight: 600, textAlign: 'center', minWidth: 36, borderRight: `1px solid ${readerNightMode ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.08)'}` }}>
                                {readerFontSize}
                            </span>
                            <button onClick={() => { const v = Math.min(22, readerFontSize + 1); setReaderFontSize(v); localStorage.setItem('coread-font-size', String(v)); }}
                                style={{ flex: 1, padding: '8px 0', background: 'none', border: 'none', cursor: 'pointer', fontSize: 16, fontFamily: 'serif', color: readerNightMode ? '#aaa' : '#666' }}>
                                A<span style={{ fontSize: 9, verticalAlign: 'super' }}>+</span>
                            </button>
                        </div>
                        <div style={{ display: 'flex', gap: 8 }}>
                            <button onClick={() => { setReaderNightMode(false); localStorage.setItem('coread-night-mode', 'false'); }}
                                style={{ flex: 1, padding: '8px 0', borderRadius: 8, border: `1.5px solid ${!readerNightMode ? c.primary : (readerNightMode ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)')}`, background: !readerNightMode ? `${c.primary}12` : 'transparent', cursor: 'pointer', fontSize: 12, color: !readerNightMode ? c.primary : (readerNightMode ? '#777' : '#999'), fontWeight: 500 }}>
                                ☀ 日间
                            </button>
                            <button onClick={() => { setReaderNightMode(true); localStorage.setItem('coread-night-mode', 'true'); }}
                                style={{ flex: 1, padding: '8px 0', borderRadius: 8, border: `1.5px solid ${readerNightMode ? c.primary : 'rgba(0,0,0,0.06)'}`, background: readerNightMode ? `${c.primary}12` : 'transparent', cursor: 'pointer', fontSize: 12, color: readerNightMode ? c.primary : '#999', fontWeight: 500 }}>
                                ☾ 夜间
                            </button>
                        </div>

                        {/* 上下文范围 — 同一个值用于「批注触发 AI」和「从选中句主动讨论」（Phase 3） */}
                        <div style={{ marginTop: 16, paddingTop: 14, borderTop: `1px solid ${c.primaryBorder}` }}>
                            <div style={{ fontSize: 11, color: c.muted, marginBottom: 8, letterSpacing: 0.3 }}>
                                上下文 · ±{contextChars}字
                            </div>
                            <div style={{ display: 'flex', gap: 6 }}>
                                {CONTEXT_PRESETS.map(p => {
                                    const on = !contextCustom && contextChars === p;
                                    return (
                                        <button key={p} onClick={() => { setContextCustom(false); setContextChars(p); }}
                                            style={{ flex: 1, padding: '7px 0', borderRadius: 8, fontSize: 12, cursor: 'pointer', fontWeight: on ? 600 : 400,
                                                border: `1.5px solid ${on ? c.primary : c.primaryBorder}`,
                                                background: on ? `${c.primary}12` : 'transparent',
                                                color: on ? c.primary : (readerNightMode ? '#9a938a' : '#8a8378') }}>
                                            ±{p}
                                        </button>
                                    );
                                })}
                                <button onClick={() => setContextCustom(true)}
                                    style={{ flex: 1, padding: '7px 0', borderRadius: 8, fontSize: 12, cursor: 'pointer', fontWeight: contextCustom ? 600 : 400,
                                        border: `1.5px solid ${contextCustom ? c.primary : c.primaryBorder}`,
                                        background: contextCustom ? `${c.primary}12` : 'transparent',
                                        color: contextCustom ? c.primary : (readerNightMode ? '#9a938a' : '#8a8378') }}>
                                    自定义
                                </button>
                            </div>
                            {contextCustom && (
                                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
                                    <span style={{ fontSize: 12, color: c.muted }}>±</span>
                                    <input type="number" min={50} max={5000} step={50} value={contextChars}
                                        onChange={e => setContextChars(parseInt(e.target.value || '0', 10))}
                                        style={{ flex: 1, padding: '7px 10px', borderRadius: 8, border: `1px solid ${c.primaryBorder}`, fontSize: 13, outline: 'none',
                                            background: readerNightMode ? 'rgba(255,255,255,0.06)' : '#fff', color: readerNightMode ? READER_INK_NIGHT_SOFT : READER_INK_SOFT }} />
                                    <span style={{ fontSize: 12, color: c.muted }}>字</span>
                                </div>
                            )}
                        </div>
                    </div>

                    {/* 书签菜单 — 保存/更新到当前位置、回到书签，替代原来常驻的「回书签」按钮 */}
                    <div onClick={(e) => e.stopPropagation()} style={{
                        position: 'absolute', bottom: showBar ? 90 : -300, right: 16, zIndex: 20, minWidth: 190,
                        background: readerNightMode ? '#2b2924' : '#fff',
                        borderRadius: 14, padding: 6,
                        boxShadow: '0 -2px 24px rgba(0,0,0,0.10)', border: `1px solid ${c.primaryBorder}`,
                        opacity: showBookmarkMenu && showBar ? 1 : 0,
                        transform: showBookmarkMenu && showBar ? 'translateY(0)' : 'translateY(20px)',
                        transition: 'opacity 0.25s ease, transform 0.25s ease, bottom 0.3s ease',
                        pointerEvents: showBookmarkMenu && showBar ? 'auto' : 'none',
                    }}>
                        <button onClick={() => { saveBookmark(); setShowBookmarkMenu(false); }}
                            style={{ width: '100%', textAlign: 'left', background: 'none', border: 'none', cursor: 'pointer',
                                padding: '10px 12px', borderRadius: 10, fontSize: 13,
                                color: readerNightMode ? READER_INK_NIGHT_SOFT : READER_INK_SOFT }}>
                            {bookmark ? '更新到当前位置' : '保存到当前位置'}
                        </button>
                        <button onClick={() => { jumpToBookmark(); setShowBookmarkMenu(false); }} disabled={!bookmark}
                            style={{ width: '100%', textAlign: 'left', background: 'none', border: 'none',
                                cursor: bookmark ? 'pointer' : 'default', padding: '10px 12px', borderRadius: 10, fontSize: 13,
                                color: bookmark ? (readerNightMode ? READER_INK_NIGHT_SOFT : READER_INK_SOFT) : '#999', opacity: bookmark ? 1 : 0.5 }}>
                            {bookmark ? `回到书签 · p.${bookmark.page}` : '回到书签'}
                        </button>
                    </div>

                    {/* 更多操作菜单 — 目前只有导出，低频操作放这里，不再常驻底栏 */}
                    <div onClick={(e) => e.stopPropagation()} style={{
                        position: 'absolute', bottom: showBar ? 90 : -300, right: 16, zIndex: 20, minWidth: 150,
                        background: readerNightMode ? '#2b2924' : '#fff',
                        borderRadius: 14, padding: 6,
                        boxShadow: '0 -2px 24px rgba(0,0,0,0.10)', border: `1px solid ${c.primaryBorder}`,
                        opacity: showMoreMenu && showBar ? 1 : 0,
                        transform: showMoreMenu && showBar ? 'translateY(0)' : 'translateY(20px)',
                        transition: 'opacity 0.25s ease, transform 0.25s ease, bottom 0.3s ease',
                        pointerEvents: showMoreMenu && showBar ? 'auto' : 'none',
                    }}>
                        <div style={{ fontSize: 10, color: c.muted, padding: '4px 12px 6px', letterSpacing: 0.3 }}>导出</div>
                        <button onClick={() => handleExport('epub')}
                            style={{ width: '100%', textAlign: 'left', background: 'none', border: 'none', cursor: 'pointer',
                                padding: '10px 12px', borderRadius: 10, fontSize: 13,
                                color: readerNightMode ? READER_INK_NIGHT_SOFT : READER_INK_SOFT }}>
                            EPUB
                        </button>
                        <button onClick={() => handleExport('md')}
                            style={{ width: '100%', textAlign: 'left', background: 'none', border: 'none', cursor: 'pointer',
                                padding: '10px 12px', borderRadius: 10, fontSize: 13,
                                color: readerNightMode ? READER_INK_NIGHT_SOFT : READER_INK_SOFT }}>
                            Markdown
                        </button>
                    </div>
                </>
            )}

            {/* Settings overlay */}
            {showSettings && (
                <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.3)', backdropFilter: 'blur(4px)', zIndex: 30, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}
                    onClick={() => setShowSettings(false)}>
                    <div onClick={e => e.stopPropagation()} style={{ background: 'white', borderRadius: 20, padding: '24px 22px', width: '100%', maxWidth: 340, boxShadow: '0 8px 40px rgba(0,0,0,0.15)' }}>
                        <div style={{ fontSize: 15, fontWeight: 700, color: c.primaryDark, marginBottom: 18 }}>设置 Settings</div>
                        <label style={{ fontSize: 12, color: '#888', display: 'block', marginBottom: 6 }}>我的名字 My Name</label>
                        <input value={humanName} onChange={e => { setHumanName(e.target.value); localStorage.setItem('coread-human-name', e.target.value); }}
                            style={{ width: '100%', padding: '10px 14px', borderRadius: 12, border: `1px solid ${c.primaryBorder}`, fontSize: 14, marginBottom: 16, outline: 'none' }} />
                        <label style={{ fontSize: 12, color: '#888', display: 'block', marginBottom: 6 }}>AI的名字 AI Name</label>
                        <input value={aiName} onChange={e => { setAiName(e.target.value); localStorage.setItem('coread-ai-name', e.target.value); }}
                            style={{ width: '100%', padding: '10px 14px', borderRadius: 12, border: `1px solid ${c.primaryBorder}`, fontSize: 14, marginBottom: 16, outline: 'none' }} />
                        <label style={{ fontSize: 12, color: '#888', display: 'block', marginBottom: 6 }}>字体大小 Font Size</label>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 20 }}>
                            <span style={{ fontSize: 12, color: '#aaa' }}>小</span>
                            <input type="range" min={12} max={22} step={1} value={readerFontSize}
                                onChange={e => { const v = parseInt(e.target.value, 10); setReaderFontSize(v); localStorage.setItem('coread-font-size', String(v)); }}
                                style={{ flex: 1, accentColor: c.primary }} />
                            <span style={{ fontSize: 12, color: '#aaa' }}>大</span>
                            <span style={{ fontSize: 12, color: c.primary, fontWeight: 600, minWidth: 28, textAlign: 'center' }}>{readerFontSize}px</span>
                        </div>
                        <button onClick={() => setShowSettings(false)} style={{ width: '100%', padding: '10px 0', borderRadius: 14, background: c.primary, border: 'none', color: 'white', fontSize: 14, fontWeight: 600, cursor: 'pointer' }}>完成</button>
                    </div>
                </div>
            )}

            {/* CoRead 绑定选择器 — 只列 resident=claude-code / purpose=chat / 未关闭的会话。
                不做「自动绑定最近会话」；选中即立即持久化到 Morrow 一侧。 */}
            {showBindingPicker && (
                <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.3)', backdropFilter: 'blur(4px)', zIndex: 30, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}
                    onClick={() => setShowBindingPicker(false)}>
                    <div onClick={(e) => e.stopPropagation()} style={{
                        background: 'rgba(255,255,255,0.97)', backdropFilter: 'blur(20px)', borderRadius: 20,
                        padding: 20, width: '100%', maxWidth: 360, maxHeight: '70vh', display: 'flex', flexDirection: 'column',
                        border: `1px solid ${c.primaryBorder}`, boxShadow: '0 12px 40px rgba(0,0,0,0.1)',
                    }}>
                        <div style={{ fontSize: 15, fontWeight: 700, color: c.primaryDark, marginBottom: 4 }}>共读对象</div>
                        <div style={{ fontSize: 11, color: '#999', marginBottom: 14 }}>批注会持续投给这里选的聊天，直到你换一个</div>
                        {bindingError && <div style={{ fontSize: 12, color: '#e66', marginBottom: 10 }}>{bindingError}</div>}
                        <div className="no-scrollbar" style={{ overflowY: 'auto', flex: 1, marginBottom: 12 }}>
                            {bindingLoading && <div style={{ fontSize: 12, color: '#999', padding: '12px 4px' }}>加载中…</div>}
                            {!bindingLoading && bindingCandidates.length === 0 && (
                                <div style={{ fontSize: 12, color: '#999', padding: '12px 4px' }}>没有可选的聊天会话</div>
                            )}
                            {!bindingLoading && bindingCandidates.map((candidate) => {
                                const isCurrent = candidate.id === coreadBinding?.sessionId;
                                return (
                                    <button key={candidate.id} onClick={() => chooseBindingCandidate(candidate.id)} style={{
                                        width: '100%', textAlign: 'left', display: 'flex', flexDirection: 'column', gap: 2,
                                        padding: '10px 12px', borderRadius: 10, marginBottom: 6, cursor: 'pointer',
                                        border: `1.5px solid ${isCurrent ? c.primary : c.primaryBorder}`,
                                        background: isCurrent ? `${c.primary}12` : 'transparent',
                                    }}>
                                        <span style={{ fontSize: 13, fontWeight: isCurrent ? 600 : 400, color: isCurrent ? c.primary : '#333' }}>
                                            {candidate.title || '（无标题）'}{isCurrent ? ' · 当前' : ''}
                                        </span>
                                        <span style={{ fontSize: 11, color: '#aaa' }}>
                                            最近活动 {new Date(candidate.lastActivityAt).toLocaleString()}
                                        </span>
                                    </button>
                                );
                            })}
                        </div>
                        <div style={{ display: 'flex', gap: 10 }}>
                            <button onClick={unbindCoread} disabled={!coreadBinding?.sessionId} style={{
                                flex: 1, padding: '10px 0', borderRadius: 14, border: `1px solid ${c.primaryBorder}`, background: 'white',
                                fontSize: 13, color: coreadBinding?.sessionId ? '#e66' : '#ccc', cursor: coreadBinding?.sessionId ? 'pointer' : 'default',
                            }}>解绑</button>
                            <button onClick={() => setShowBindingPicker(false)} style={{ flex: 1, padding: '10px 0', borderRadius: 14, border: 'none', background: c.primary, fontSize: 13, color: 'white', cursor: 'pointer', fontWeight: 600 }}>关闭</button>
                        </div>
                    </div>
                </div>
            )}

            {/* Upload overlay */}
            {showUpload && (
                <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.3)', backdropFilter: 'blur(4px)', zIndex: 30, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}
                    onClick={() => { if (!uploading) setShowUpload(false); }}>
                    <div onClick={(e) => e.stopPropagation()} style={{
                        background: 'rgba(255,255,255,0.97)', backdropFilter: 'blur(20px)', borderRadius: 24,
                        padding: 24, width: '100%', maxWidth: 360, border: `1px solid ${c.primaryBorder}`, boxShadow: '0 12px 40px rgba(0,0,0,0.1)',
                    }}>
                        <div style={{ fontSize: 16, fontWeight: 700, color: c.primaryDark, marginBottom: 16 }}>上传书籍</div>

                        <input value={uploadTitle} onChange={e => setUploadTitle(e.target.value)} placeholder="书名"
                            style={{ width: '100%', padding: '10px 14px', borderRadius: 12, border: `1px solid ${c.primaryBorder}`, fontSize: 14, outline: 'none', marginBottom: 12, background: c.primaryBg, color: '#333' }} />

                        <input ref={fileInputRef} type="file" accept=".pdf,.txt,.md,.epub" onChange={handleFileSelect} style={{ display: 'none' }} />
                        <button onClick={() => fileInputRef.current?.click()} style={{
                            width: '100%', padding: '10px 14px', borderRadius: 12, border: `1px dashed ${c.primaryBorder}`,
                            background: c.primaryBg, fontSize: 13, color: c.primary, cursor: 'pointer', marginBottom: 8, textAlign: 'center',
                        }}>
                            {uploadFileName ? `已选: ${uploadFileName}` : '选择文件（PDF / TXT）'}
                        </button>

                        <div style={{ textAlign: 'center', fontSize: 11, color: '#ccc', margin: '4px 0 8px' }}>— 或者 —</div>

                        <textarea value={uploadText} onChange={e => { setUploadText(e.target.value); setPdfBase64(''); setUploadFileName(''); }}
                            placeholder="粘贴文本内容...（段落之间用空行分隔）"
                            style={{ width: '100%', minHeight: 100, padding: '10px 14px', borderRadius: 12, border: `1px solid ${c.primaryBorder}`, fontSize: 13, outline: 'none', resize: 'vertical', background: c.primaryBg, color: '#333', lineHeight: 1.5 }} />

                        <input ref={batchFileRef} type="file" accept=".epub" multiple onChange={handleBatchUpload} style={{ display: 'none' }} />
                        <button onClick={() => batchFileRef.current?.click()} disabled={uploading} style={{
                            width: '100%', padding: '10px 0', borderRadius: 14, border: `1px dashed ${c.primary}`,
                            background: `${c.primary}10`, fontSize: 13, color: c.primary, cursor: 'pointer', marginTop: 12, fontWeight: 600,
                        }}>
                            {uploading ? '批量上传中...' : '批量上传 epub'}
                        </button>

                        <div style={{ display: 'flex', gap: 10, marginTop: 12 }}>
                            <button onClick={() => setShowUpload(false)} disabled={uploading}
                                style={{ flex: 1, padding: '10px 0', borderRadius: 14, border: `1px solid ${c.primaryBorder}`, background: 'white', fontSize: 13, color: '#999', cursor: 'pointer' }}>取消</button>
                            <button onClick={handleUpload} disabled={uploading}
                                style={{ flex: 1, padding: '10px 0', borderRadius: 14, border: 'none', background: c.primary, fontSize: 13, color: 'white', cursor: 'pointer', fontWeight: 600, opacity: uploading ? 0.6 : 1 }}>
                                {uploading ? '上传中...' : '添加到书架'}
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* TOC overlay */}
            {showToc && (
                <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.3)', backdropFilter: 'blur(4px)', zIndex: 30, display: 'flex', alignItems: 'flex-start', justifyContent: 'center', paddingTop: 80 }}
                    onClick={() => setShowToc(false)}>
                    <div ref={tocListRef} onClick={(e) => e.stopPropagation()} onScroll={(e) => setTocScrollTop((e.target as HTMLDivElement).scrollTop)} style={{
                        background: 'rgba(255,255,255,0.97)', backdropFilter: 'blur(20px)', borderRadius: 20,
                        padding: '0', width: 'calc(100% - 40px)', maxWidth: 360, maxHeight: '60vh', overflow: 'auto',
                        border: `1px solid ${c.primaryBorder}`, boxShadow: '0 12px 40px rgba(0,0,0,0.1)',
                    }} className="no-scrollbar">
                        <div style={{ fontSize: 14, fontWeight: 700, color: c.primaryDark, padding: '16px 20px 12px', borderBottom: `1px solid ${c.primaryBorder}`, position: 'sticky', top: 0, background: 'rgba(255,255,255,0.97)', zIndex: 1 }}>目录</div>
                        {(() => {
                            // 窗口化渲染：几千章全量挂DOM滑动会卡/出空白，只渲染可视区±8行缓冲；
                            // 固定行高 TOC_ROW_H，用 spacer 撑出总高，行绝对定位
                            const viewH = tocViewH || 400;
                            const winStart = Math.max(0, Math.floor(tocScrollTop / TOC_ROW_H) - 8);
                            const winEnd = Math.min(tocChapters.length, Math.ceil((tocScrollTop + viewH) / TOC_ROW_H) + 8);
                            const rows = [];
                            for (let i = winStart; i < winEnd; i++) {
                                const ch = tocChapters[i];
                                // 目录页码与底部页码同源：按全书视觉分页表换算（后端章节分页坐标不同义）
                                const pg = findPageForParaIdx(ch.idx ?? ch.page);
                                const chPage = pg >= 0 ? pg + 1 : ch.page;
                                const isCurrent = i === currentChapterIdx;
                                rows.push(
                                    <button key={i} onClick={() => jumpToChapter(ch)} style={{
                                        position: 'absolute', top: i * TOC_ROW_H, left: 0, right: 0, height: TOC_ROW_H,
                                        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                                        padding: '0 20px', background: isCurrent ? c.primaryBg : 'transparent',
                                        border: 'none', borderBottom: `1px solid ${c.primaryBorder}22`, cursor: 'pointer', textAlign: 'left',
                                    }}>
                                        <span style={{ fontSize: 13, color: isCurrent ? c.primary : '#444', fontWeight: isCurrent ? 600 : 400, flex: 1, lineHeight: 1.4, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{ch.title}</span>
                                        <span style={{ fontSize: 11, color: '#bbb', marginLeft: 8, flexShrink: 0 }}>p.{chPage}</span>
                                    </button>
                                );
                            }
                            return <div style={{ position: 'relative', height: tocChapters.length * TOC_ROW_H }}>{rows}</div>;
                        })()}
                    </div>
                </div>
            )}
        </div>
    );
};

export default StudyApp;
