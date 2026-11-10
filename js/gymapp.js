// ============================================================
//  מה שהדפדפן מספק במקום ה-API-ים הנייטיביים.
//
//  כל פונקציה כאן היא הצד השני של shim ב-Web/Shims. החלוקה היא
//  לפי יכולת: קבצים, תמונות, שיתוף, לוח, ואחסון מתמשך.
// ============================================================

window.gymapp = (() => {

    // ---------- המרות ----------

    function base64ToBlob(base64, type) {
        const bin = atob(base64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        return new Blob([bytes], { type: type || "application/octet-stream" });
    }

    function blobToBase64(blob) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            // readAsDataURL ולא לולאה ב-JS: ההמרה נעשית במנוע הדפדפן
            // ומהירה בסדר גודל.
            reader.onload = () => resolve(reader.result.slice(reader.result.indexOf(",") + 1));
            reader.onerror = () => reject(reader.error);
            reader.readAsDataURL(blob);
        });
    }

    // ---------- תמונות ----------

    async function encodeJpeg(base64, maxEdge, quality) {
        // imageOrientation מיישר לפי ה-EXIF. בלעדיו תמונות שצולמו בטלפון
        // מוצגות מסובבות ב-90 מעלות — אותה עבודה שבגרסה הנייטיבית נעשית
        // ידנית ב-SkiaSharp, כאן בחינם.
        const bitmap = await createImageBitmap(base64ToBlob(base64), { imageOrientation: "from-image" });

        const longest = Math.max(bitmap.width, bitmap.height);
        const scale = longest <= maxEdge ? 1 : maxEdge / longest;

        const width = Math.max(1, Math.round(bitmap.width * scale));
        const height = Math.max(1, Math.round(bitmap.height * scale));

        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        canvas.getContext("2d").drawImage(bitmap, 0, 0, width, height);
        bitmap.close();

        const encoded = await new Promise(r => canvas.toBlob(r, "image/jpeg", quality));
        return await blobToBase64(encoded);
    }

    // ---------- בחירת קבצים ----------

    function pick(accept, multiple, capture, imageMaxEdge) {
        return new Promise(resolve => {
            const input = document.createElement("input");
            input.type = "file";
            if (accept) input.accept = accept;
            if (multiple) input.multiple = true;

            // capture פותח את המצלמה ישירות. דפדפן בלי מצלמה מתעלם
            // מהתכונה ומציג את בוחר הקבצים - fallback מובנה.
            if (capture) input.setAttribute("capture", "environment");

            input.style.display = "none";
            document.body.appendChild(input);

            let settled = false;
            const finish = async (files) => {
                if (settled) return;
                settled = true;
                input.remove();
                resolve(await Promise.all(files));
            };

            input.addEventListener("change", () => {
                const files = Array.from(input.files || []);

                finish(files.map(async file => {
                    const base64 = await blobToBase64(file);

                    // תמונה מוקטנת כאן, לפני המעבר ל-C#. מצלמה מחזירה
                    // 3-12MB, והמעבר דרך interop הוא base64 - עוד שליש
                    // נפח. ההקטנה היא לאותו גבול שהאחסון שומר בו בכל
                    // מקרה, ולכן אין בה אובדן.
                    const isImage = file.type.startsWith("image/");
                    const data = isImage ? await encodeJpeg(base64, imageMaxEdge, 0.85) : base64;

                    return { name: file.name, data: data };
                }));
            });

            // ביטול. אירוע cancel קיים בדפדפנים חדשים; הגיבוי הוא חזרת
            // המיקוד לחלון בלי בחירה. בלי אחד מהשניים ההמתנה ב-C# לא
            // הייתה נגמרת והממשק היה נתקע על "טוען".
            input.addEventListener("cancel", () => finish([]));
            window.addEventListener("focus", () => setTimeout(() => finish([]), 2000), { once: true });

            input.click();
        });
    }

    // ---------- שיתוף ----------

    async function shareText(title, text) {
        if (navigator.share) {
            try {
                await navigator.share({ title: title || undefined, text: text });
                return;
            } catch (e) {
                // AbortError = המשתמש סגר את גיליון השיתוף. לא שגיאה.
                if (e && e.name === "AbortError") return;
            }
        }
        await navigator.clipboard.writeText(text);
    }

    async function shareFile(title, fileName, base64) {
        const file = new File([base64ToBlob(base64)], fileName);

        if (navigator.canShare && navigator.canShare({ files: [file] })) {
            try {
                await navigator.share({ title: title || undefined, files: [file] });
                return;
            } catch (e) {
                if (e && e.name === "AbortError") return;
            }
        }

        // גיבוי: הורדה. לא שיתוף, אבל המשתמש מקבל את הקובץ ויכול לשלוח
        // אותו בעצמו - עדיף על כישלון שקט.
        const url = URL.createObjectURL(file);
        const link = document.createElement("a");
        link.href = url;
        link.download = fileName;
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 10000);
    }

    // ---------- אחסון מתמשך ----------
    //
    //  מערכת הקבצים של ה-WebAssembly יושבת בזיכרון ונמחקת ברענון.
    //  כאן היא מגובה ל-IndexedDB: נטענת בעלייה, ונשמרת בכל שינוי.
    //
    //  למה IndexedDB ולא localStorage: גבול הנפח. localStorage הוא
    //  5MB, ותמונות עוברות אותו ביום אחד.

    const DB_NAME = "gymapp";
    const STORE = "appdata";
    let dbPromise = null;

    function db() {
        if (!dbPromise) {
            dbPromise = new Promise((resolve, reject) => {
                const request = indexedDB.open(DB_NAME, 1);
                request.onupgradeneeded = () => request.result.createObjectStore(STORE);
                request.onsuccess = () => resolve(request.result);
                request.onerror = () => reject(request.error);
            });
        }
        return dbPromise;
    }

    async function write(mode, work) {
        const database = await db();
        return new Promise((resolve, reject) => {
            const transaction = database.transaction(STORE, mode);
            work(transaction.objectStore(STORE));
            transaction.oncomplete = () => resolve();
            transaction.onerror = () => reject(transaction.error);
        });
    }

    async function loadAll() {
        const database = await db();
        return new Promise((resolve, reject) => {
            const transaction = database.transaction(STORE, "readonly");
            const store = transaction.objectStore(STORE);
            const keys = store.getAllKeys();
            const values = store.getAll();
            transaction.oncomplete = () => resolve(
                keys.result.map((key, i) => ({ path: key, data: values.result[i] })));
            transaction.onerror = () => reject(transaction.error);
        });
    }

    const put = (path, base64) => write("readwrite", store => store.put(base64, path));
    const remove = (path) => write("readwrite", store => store.delete(path));

    // השמירה נדגמת ואינה מופעלת מהכתיבה עצמה, כי הכתיבות עוברות
    // ב-System.IO של .NET ואין וו להיתפס בו. שתי נקודות הדגימה: כל שתי
    // שניות, ובכל רגע שהדף מוסתר - באייפון זה מה שקורה כשעוברים
    // לאפליקציה אחרת, וזו ההזדמנות האחרונה לכתוב.
    function watch(dotnet) {
        const flush = () => dotnet.invokeMethodAsync("FlushAsync");

        setInterval(flush, 2000);
        document.addEventListener("visibilitychange", () => { if (document.hidden) flush(); });
        window.addEventListener("pagehide", flush);
    }

    return {
        files: { pick },
        images: { encodeJpeg },
        share: { text: shareText, file: shareFile },
        clipboard: {
            read: () => navigator.clipboard.readText(),
            write: (text) => navigator.clipboard.writeText(text)
        },
        store: { loadAll, put, remove, watch }
    };
})();
