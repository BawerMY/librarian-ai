import os
from dotenv import load_dotenv
from qdrant_client import QdrantClient
from sentence_transformers import SentenceTransformer
from pathlib import Path
import uuid
from qdrant_client.models import Distance, VectorParams, PointStruct

load_dotenv()

QDRANT_URL = os.environ.get("QDRANT_URL")
QDRANT_API_KEY = os.environ.get("QDRANT_API_KEY")
MODEL_NAME = os.environ.get("MODEL_NAME")
TEXT_PATH = Path(os.environ.get("TEXT_PATH")).expanduser()
CHUNK_SIZE = int(os.environ.get("CHUNK_SIZE"))
CHUNK_OVERLAP = int(os.environ.get("CHUNK_OVERLAP"))
COLLECTION_NAME = os.environ.get("COLLECTION_NAME", "books")

client = QdrantClient(url=QDRANT_URL, api_key=QDRANT_API_KEY)

model = SentenceTransformer(MODEL_NAME, device="cpu")
EMBEDDING_DIM = model.get_sentence_embedding_dimension()

text = TEXT_PATH.read_text(encoding="utf-8", errors="ignore")

def chunk_text(text):
    text = " ".join(text.split())
    chunks = []
    start = 0
    while start < len(text):
        end = min(start + CHUNK_SIZE, len(text))
        if end < len(text):
            space = text.rfind(" ", start, end)
            if space > start + CHUNK_SIZE // 2:
                end = space
        chunk = text[start:end].strip()
        if chunk:
            chunks.append(chunk)
        if end >= len(text):
            break
        start = end - CHUNK_OVERLAP
    return chunks


chunks = chunk_text(text)

def upload_chunks(collection_name, chunks):
    vectors = model.encode(
        chunks,
        batch_size=32,
        show_progress_bar=True,
        normalize_embeddings=True,
    )

    if not client.collection_exists(collection_name):
        client.create_collection(
            collection_name=collection_name,
            vectors_config=VectorParams(size=EMBEDDING_DIM, distance=Distance.COSINE),
        )

    source = TEXT_PATH.name
    points = [
        PointStruct(
            id=str(uuid.uuid5(uuid.NAMESPACE_URL, f"{source}:{i}")),
            vector=vector.tolist(),
            payload={"text": chunk, "source": source, "chunk_index": i},
        )
        for i, (chunk, vector) in enumerate(zip(chunks, vectors))
    ]

    for i in range(0, len(points), 64):
        client.upsert(collection_name=collection_name, points=points[i:i + 64])

    print(f"Uploaded {len(points)} chunks from '{source}' to '{collection_name}'")

upload_chunks(COLLECTION_NAME, chunks)
