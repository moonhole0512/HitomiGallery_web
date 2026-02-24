import os
import json
import uvicorn
import aiosqlite
import re
import time
import zipfile
import io
import requests
import send2trash
from PIL import Image
import logging

from fastapi import FastAPI, HTTPException, Query, BackgroundTasks, Request
from fastapi.responses import HTMLResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from jinja2 import Environment, FileSystemLoader
from pydantic import BaseModel

# -----------------------------------------------------------------------------
# Logging Configuration
# -----------------------------------------------------------------------------

LOGGING_CONFIG = {
    "version": 1,
    "disable_existing_loggers": False,
    "formatters": {
        "default": {
            "()": "uvicorn.logging.DefaultFormatter",
            "fmt": "%(asctime)s - %(levelname)s - %(message)s",
            "datefmt": "%Y-%m-%d %H:%M:%S",
        },
    },
    "handlers": {
        "default": {
            "formatter": "default",
            "class": "logging.StreamHandler",
            "stream": "ext://sys.stderr",
        },
    },
    "loggers": {
        "hitomi": {"handlers": ["default"], "level": "DEBUG"},
        "uvicorn": {"handlers": ["default"], "level": "INFO"},
    },
}

logger = logging.getLogger("hitomi")

# -----------------------------------------------------------------------------
# Configuration & Constants
# -----------------------------------------------------------------------------

DB_PATH = "hitomi.db"
SETTINGS_PATH = "settings.json"
JPG_WIDTH = 165
JPG_HEIGHT = 220
JPG_QUALITY = 90

def load_settings():
    if not os.path.exists(SETTINGS_PATH):
        raise RuntimeError("Settings file not found. Please create settings.json.")
    with open(SETTINGS_PATH, 'r') as f:
        return json.load(f)

settings = load_settings()
ROOT_DIR = settings.get("ROOT_DIR")
COVER_DIR = settings.get("COVER_DIR")

# -----------------------------------------------------------------------------
# FastAPI App Initialization
# -----------------------------------------------------------------------------

app = FastAPI()

# Mount static files directories
app.mount("/static", StaticFiles(directory="static"), name="static")
if COVER_DIR and os.path.isdir(COVER_DIR):
    app.mount("/cover", StaticFiles(directory=COVER_DIR), name="cover")
else:
    logger.warning(f"COVER_DIR '{COVER_DIR}' not found. Cover images will not be served.")

# Jinja2 for HTML templates
templates = Environment(loader=FileSystemLoader("templates"))
templates.globals['version'] = int(time.time())

# -----------------------------------------------------------------------------
# Helper Functions (Ported from original script)
# -----------------------------------------------------------------------------

def json_parser(url):
    try:
        response = requests.get(url)
        if response.status_code == 200:
            return json.loads(response.text[18:])
    except Exception as e:
        logger.error(f"Error parsing JSON: {e}")
    return {}

def get_substring_by_string(text):
    matches = re.findall(r'\(([^)\D]*)\)', text)
    return matches[-1] if matches else "0"

def multi_tag_string(obj, tag):
    if obj is None or not isinstance(obj, list):
        return ""
    return ",".join([item.get(tag, "") for item in obj if isinstance(item, dict)])

def insert_query(obj, file):
    return (
        get_substring_by_string(os.path.basename(file)),
        os.path.basename(file),
        os.path.dirname(file),
        obj.get('title', ''),
        multi_tag_string(obj.get('artists'), 'artist'),
        multi_tag_string(obj.get('tags'), 'tag'),
        multi_tag_string(obj.get('groups'), 'group'),
        multi_tag_string(obj.get('parodys'), 'parody'),
        multi_tag_string(obj.get('characters'), 'character'),
        obj.get('language_localname', '')
    )

async def sql_insert(db, data):
    try:
        await db.execute(
            '''INSERT INTO files(id_hitomi, filename, path, title, artist,
                             tags, groups_, series, characters, language)
                             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)''', data)
        await db.commit()
    except aiosqlite.Error as e:
        logger.error(f"Database error during insert: {e}")

async def sql_select_count(db, file):
    try:
        cursor = await db.execute(
            'SELECT COUNT(*) FROM files WHERE path = ? AND filename = ?',
            (os.path.dirname(file), os.path.basename(file)))
        return (await cursor.fetchone())[0]
    except aiosqlite.Error as e:
        logger.error(f"Database error during select count: {e}")
        return 0

def unzip_img_to_cover(dir_path, file_path):
    gal_num = get_substring_by_string(os.path.basename(file_path))
    if gal_num == "0":
        return

    cover_path = os.path.join(dir_path, f"{gal_num}.jpg")
    if os.path.exists(cover_path):
        return

    with zipfile.ZipFile(file_path, 'r') as zip_ref:
        for item in zip_ref.namelist():
            if item.lower().endswith(('.jpg', '.png', '.webp', '.gif', '.jpeg')):
                img_data = zip_ref.read(item)
                with Image.open(io.BytesIO(img_data)) as img:
                    img = img.resize((JPG_WIDTH, JPG_HEIGHT), Image.Resampling.LANCZOS)
                    img = img.convert('RGB')
                    img.save(cover_path, 'JPEG', quality=JPG_QUALITY)
                break

async def update_database_task():
    logger.info("Starting database update...")
    db = await aiosqlite.connect(DB_PATH)
    zip_files = [os.path.join(root, file) for root, _, files in os.walk(ROOT_DIR) for file in files if file.endswith('.zip')]
    total_files = len(zip_files)

    for i, full_path in enumerate(zip_files, 1):
        logger.info(f"Processing {i}/{total_files}: {os.path.basename(full_path)}")
        gal_num = get_substring_by_string(os.path.basename(full_path))
        if gal_num == "0":
            continue

        try:
            if await sql_select_count(db, full_path) == 0:
                obj = json_parser(f"https://ltn.gold-usergeneratedcontent.net/galleries/{gal_num}.js")
                if not obj:
                    obj['title'] = os.path.basename(full_path)
                
                data = insert_query(obj, full_path)
                await sql_insert(db, data)
                time.sleep(0.2) # Respect API rate limits

            unzip_img_to_cover(COVER_DIR, full_path)

        except Exception as e:
            logger.error(f"Error processing {full_path}: {e}")

    await db.close()
    logger.info("Database update finished.")

# -----------------------------------------------------------------------------
# Database Connection
# -----------------------------------------------------------------------------

async def get_db():
    db = await aiosqlite.connect(DB_PATH)
    db.row_factory = aiosqlite.Row
    return db

# -----------------------------------------------------------------------------
# Pydantic Models
# -----------------------------------------------------------------------------

class RateUpdate(BaseModel):
    rate: int

class CoverUpdate(BaseModel):
    path: str

@app.on_event("startup")
async def startup_event():
    async with aiosqlite.connect(DB_PATH) as db:
        # reg_date 컬럼 추가 마이그레이션
        try:
            await db.execute("ALTER TABLE files ADD COLUMN reg_date DATETIME DEFAULT CURRENT_TIMESTAMP")
            await db.commit()
            logger.info("Database migrated: reg_date column added.")
        except aiosqlite.OperationalError:
            pass # Already exists

@app.get("/", response_class=HTMLResponse)
async def read_root(request: Request):
    template = templates.get_template("index.html")
    return HTMLResponse(content=template.render(request=request))

@app.get("/reader/{id_hitomi}", response_class=HTMLResponse)
async def read_item(request: Request, id_hitomi: int):
    template = templates.get_template("reader.html")
    return HTMLResponse(content=template.render(request=request, id_hitomi=id_hitomi))

@app.get("/api/galleries")
async def search_galleries(
    title: str = Query(None), person: str = Query(None), tags: str = Query(None),
    series: str = Query(None), rate: str = Query("All"),
    characters: str = Query(None), sort: str = Query("DESC"), page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1),
    seed: float = Query(None)
):
    async with aiosqlite.connect(DB_PATH) as db:
        if seed is not None:
            # Register a deterministic random function based on ID and seed
            def seeded_random(id_val, seed_val):
                import hashlib
                # Create a stable but "random-looking" float from id and seed
                h = hashlib.md5(f"{id_val}-{seed_val}".encode()).hexdigest()
                return int(h[:8], 16) / 0xFFFFFFFF
            
            await db.create_function("seeded_random", 2, seeded_random)

        db.row_factory = aiosqlite.Row
        query = 'SELECT id_hitomi, title, artist, groups_, series, characters, tags, rate FROM files WHERE 1=1'
        params = []

        if title:
            query += ' AND (title LIKE ? OR filename LIKE ?)'
            params.extend([f'%{title}%', f'%{title}%'])
        if person:
            query += ' AND (artist LIKE ? OR groups_ LIKE ?)'
            params.extend([f'%{person}%', f'%{person}%'])
        if tags:
            for tag in tags.split(','):
                if tag.strip():
                    query += ' AND tags LIKE ?'
                    params.append(f'%{tag.strip()}%')
        if series:
            query += ' AND series LIKE ?'
            params.append(f'%{series}%')
        if characters:
            query += ' AND characters LIKE ?'
            params.append(f'%{characters}%')
        if rate != "All" and rate.isdigit():
            query += ' AND rate = ?'
            params.append(int(rate))

        count_query = query.replace("SELECT id_hitomi, title, artist, groups_, series, characters, tags, rate", "SELECT COUNT(*)")
        cursor = await db.execute(count_query, tuple(params))
        total_results = (await cursor.fetchone())[0]
        total_pages = (total_results + page_size - 1) // page_size

        if sort == "DESC": query += ' ORDER BY id_hitomi DESC'
        elif sort == "ASC": query += ' ORDER BY id_hitomi ASC'
        elif sort == "NEWEST_DB": query += ' ORDER BY reg_date DESC'
        elif sort == "OLDEST_DB": query += ' ORDER BY reg_date ASC'
        elif sort == "RANDOM":
            if seed is not None:
                query += ' ORDER BY seeded_random(id_hitomi, ?)'
                params.append(seed)
            else:
                query += ' ORDER BY RANDOM()'
        
        offset = (page - 1) * page_size
        query += ' LIMIT ? OFFSET ?'
        params.extend([page_size, offset])

        cursor = await db.execute(query, tuple(params))
        results = await cursor.fetchall()

        logger.debug(f"Query: {query}")
        logger.debug(f"Params: {params}")
        logger.debug(f"DB Results: {[dict(row) for row in results]}")

        galleries_data = []
        for row in results:
            gallery_dict = dict(row)
            artist = gallery_dict.get('artist')
            groups = gallery_dict.get('groups_')
            person = ', '.join(filter(None, [artist, groups]))
            gallery_dict['person'] = person
            galleries_data.append(gallery_dict)

        logger.debug(f"Final Galleries Data: {galleries_data}")

        return {
            "galleries": galleries_data,
            "currentPage": page, "totalPages": total_pages, "totalResults": total_results,
        }

@app.get("/api/autocomplete")
async def autocomplete(field: str, query: str):
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        suggestions = []
        search_term = f"%{query}%"

        if field == "person":
            # Search both artist and groups_
            cursor = await db.execute(
                'SELECT DISTINCT artist AS value FROM files WHERE artist LIKE ? UNION SELECT DISTINCT groups_ AS value FROM files WHERE groups_ LIKE ? LIMIT 5',
                (search_term, search_term)
            )
            results = await cursor.fetchall()
            suggestions = [row['value'] for row in results if row['value']]
            # Filter out None values and duplicates, then take top 5
            suggestions = list(dict.fromkeys([s for s in suggestions if s is not None]))[:5]

        elif field == "series":
            cursor = await db.execute(
                'SELECT DISTINCT series AS value FROM files WHERE series LIKE ? LIMIT 5',
                (search_term,)
            )
            results = await cursor.fetchall()
            suggestions = [row['value'] for row in results if row['value']]

        elif field == "characters":
            cursor = await db.execute(
                'SELECT DISTINCT characters AS value FROM files WHERE characters LIKE ? LIMIT 5',
                (search_term,)
            )
            results = await cursor.fetchall()
            suggestions = [row['value'] for row in results if row['value']]
        
        return JSONResponse(content={"suggestions": suggestions})

@app.post("/api/update")
async def update_db_endpoint(background_tasks: BackgroundTasks):
    background_tasks.add_task(update_database_task)
    return JSONResponse(content={"message": "Database update started in the background."})

@app.put("/api/galleries/{id_hitomi}/rate")
async def set_rating(id_hitomi: int, item: RateUpdate):
    if not (0 <= item.rate <= 5):
        raise HTTPException(status_code=400, detail="Rate must be between 0 and 5.")
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute('UPDATE files SET rate = ? WHERE id_hitomi = ?', (item.rate, id_hitomi))
        await db.commit()
    return JSONResponse(content={"message": f"Rating for {id_hitomi} updated to {item.rate}."})

@app.delete("/api/galleries/{id_hitomi}")
async def delete_gallery_item(id_hitomi: int):
    async with aiosqlite.connect(DB_PATH) as db:
        cursor = await db.execute('SELECT path, filename FROM files WHERE id_hitomi = ?', (id_hitomi,))
        result = await cursor.fetchone()
        if not result:
            raise HTTPException(status_code=404, detail="Item not found.")

        path, filename = result
        full_path = os.path.join(path, filename)
        cover_path = os.path.join(COVER_DIR, f"{id_hitomi}.jpg")

        try:
            if os.path.exists(full_path): send2trash.send2trash(full_path)
            if os.path.exists(cover_path): send2trash.send2trash(cover_path)
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"Failed to delete files: {e}")

        await db.execute('DELETE FROM files WHERE id_hitomi = ?', (id_hitomi,))
        await db.commit()
        return JSONResponse(content={"message": f"Item {id_hitomi} deleted."})

@app.get("/api/galleries/{id_hitomi}/images")
async def get_zip_images(id_hitomi: int):
    async with aiosqlite.connect(DB_PATH) as db:
        cursor = await db.execute('SELECT path, filename FROM files WHERE id_hitomi = ?', (id_hitomi,))
        result = await cursor.fetchone()
        if not result:
            raise HTTPException(status_code=404, detail="Item not found.")

    path, filename = result
    full_path = os.path.join(path, filename)
    if not os.path.exists(full_path):
        raise HTTPException(status_code=404, detail="Zip file not found.")

    with zipfile.ZipFile(full_path, 'r') as zip_ref:
        image_files = sorted([f for f in zip_ref.namelist() if f.lower().endswith(('.jpg', '.jpeg', '.png', '.gif', '.webp'))])
    
    return JSONResponse(content={"images": image_files})

@app.get("/api/galleries/{id_hitomi}/image")
async def get_image_from_zip(id_hitomi: int, path: str = Query(...)):
    async with aiosqlite.connect(DB_PATH) as db:
        cursor = await db.execute('SELECT path, filename FROM files WHERE id_hitomi = ?', (id_hitomi,))
        result = await cursor.fetchone()
        if not result:
            raise HTTPException(status_code=404, detail="Item not found.")

    db_path, db_filename = result
    full_path = os.path.join(db_path, db_filename)
    if not os.path.exists(full_path):
        raise HTTPException(status_code=404, detail="Zip file not found.")

    try:
        with zipfile.ZipFile(full_path, 'r') as zip_ref:
            image_data = zip_ref.read(path)
            media_type = 'image/jpeg'
            if path.lower().endswith('.png'): media_type = 'image/png'
            elif path.lower().endswith('.gif'): media_type = 'image/gif'
            elif path.lower().endswith('.webp'): media_type = 'image/webp'
            
            return StreamingResponse(io.BytesIO(image_data), media_type=media_type)
    except KeyError:
        raise HTTPException(status_code=404, detail="Image not found in zip file.")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Error reading zip file: {e}")

@app.put("/api/galleries/{id_hitomi}/cover")
async def set_cover(id_hitomi: int, item: CoverUpdate):
    logger.info(f"Received request to change cover for ID: {id_hitomi} to path: {item.path}")
    async with aiosqlite.connect(DB_PATH) as db:
        cursor = await db.execute('SELECT path, filename FROM files WHERE id_hitomi = ?', (id_hitomi,))
        result = await cursor.fetchone()
        if not result:
            raise HTTPException(status_code=404, detail="Item not found.")

    db_path, db_filename = result
    full_path = os.path.join(db_path, db_filename)
    if not os.path.exists(full_path):
        raise HTTPException(status_code=404, detail="Zip file not found.")

    new_cover_path_in_zip = item.path
    new_cover_filename_on_disk = os.path.join(COVER_DIR, f"{id_hitomi}.jpg")

    try:
        with zipfile.ZipFile(full_path, 'r') as zip_ref:
            with zip_ref.open(new_cover_path_in_zip) as file:
                img_data = file.read()
                with Image.open(io.BytesIO(img_data)) as img:
                    img = img.resize((JPG_WIDTH, JPG_HEIGHT), Image.Resampling.LANCZOS)
                    img = img.convert('RGB')
                    img.save(new_cover_filename_on_disk, 'JPEG', quality=JPG_QUALITY)
        return JSONResponse(content={"message": f"Cover for {id_hitomi} has been updated."})
    except KeyError:
        raise HTTPException(status_code=404, detail="New cover image not found in zip file.")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to update cover: {e}")

@app.get("/api/recommend")
async def recommend_galleries(limit: int = Query(40)):
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        
        # 1. 별점이 있는 데이터 가져오기
        cursor = await db.execute('SELECT artist, groups_, tags, characters, series, rate FROM files WHERE rate > 0')
        rated_items = await cursor.fetchall()
        
        if not rated_items:
            return {"galleries": [], "message": "별점을 준 작품이 없어 추천할 수 없습니다."}

        # 2. 취향 분석 (가중치 계산)
        preferences = {
            "tags": {}, "artist": {}, "groups_": {}, "characters": {}, "series": {}
        }

        for item in rated_items:
            weight = item['rate']
            for field in preferences.keys():
                val = item[field]
                if val:
                    # 쉼표로 구분된 태그들 처리
                    parts = [p.strip() for p in val.split(',') if p.strip()]
                    for part in parts:
                        preferences[field][part] = preferences[field].get(part, 0) + weight

        # 3. 상위 키워드 추출
        top_preferences = {}
        for field, counts in preferences.items():
            # 점수 순으로 정렬하여 상위 항목 추출
            sorted_items = sorted(counts.items(), key=lambda x: x[1], reverse=True)
            # 태그는 상위 15개, 나머지는 상위 5개 정도 사용
            top_n = 15 if field == "tags" else 5
            top_preferences[field] = [item[0] for item in sorted_items[:top_n]]

        # 4. 추천 쿼리 생성
        # 아직 별점을 주지 않은(rate=0) 작품 중에서 상위 키워드를 포함하는 것 검색
        query = 'SELECT id_hitomi, title, artist, groups_, series, characters, tags, rate FROM files WHERE rate = 0 AND ('
        conditions = []
        params = []

        for field, values in top_preferences.items():
            for val in values:
                conditions.append(f"{field} LIKE ?")
                params.append(f"%{val}%")

        if not conditions:
            return {"galleries": []}

        query += " OR ".join(conditions)
        query += ') ORDER BY RANDOM() LIMIT ?'
        params.append(limit)

        cursor = await db.execute(query, tuple(params))
        results = await cursor.fetchall()

        galleries_data = []
        for row in results:
            gallery_dict = dict(row)
            gallery_dict['person'] = ', '.join(filter(None, [gallery_dict.get('artist'), gallery_dict.get('groups_')]))
            galleries_data.append(gallery_dict)

        return {"galleries": galleries_data}

# -----------------------------------------------------------------------------
# Main
# -----------------------------------------------------------------------------

if __name__ == "__main__":
    uvicorn.run("main:app", host="127.0.0.1", port=8001, reload=True, log_config=LOGGING_CONFIG)
