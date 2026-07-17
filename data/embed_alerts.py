"""
embed_alerts.py — Generate semantic embeddings for cleaned alert messages.

Uses a small, fast local sentence-transformer model (e.g., all-MiniLM-L6-v2)
to convert the 'cleaned_message' text into dense vector embeddings.
These embeddings will be used later for similarity clustering.

Input: demo_alerts.csv
Output: demo_alerts_embedded.npz (or just a CSV with embedding columns)
        We'll save them to an NPZ file (NumPy array) or JSON to keep it clean.
"""

import csv
import os
import time
import numpy as np

try:
    from sentence_transformers import SentenceTransformer
except ImportError:
    print("Error: sentence-transformers is not installed.")
    print("Run: pip install sentence-transformers numpy")
    exit(1)

def embed_messages(csv_path, out_path, model_name='all-MiniLM-L6-v2'):
    print(f"Loading embedding model: {model_name} (this may download weights on first run)...")
    model = SentenceTransformer(model_name)
    
    alerts = []
    messages_to_embed = []
    
    print(f"Reading {csv_path}...")
    with open(csv_path, 'r', encoding='utf-8') as f:
        reader = csv.DictReader(f)
        for row in reader:
            alerts.append(row)
            messages_to_embed.append(row['cleaned_message'])
            
    print(f"Loaded {len(alerts)} alerts.")
    print(f"Generating embeddings for {len(alerts)} messages... (this may take a minute)")
    
    start_time = time.time()
    # Generate embeddings
    embeddings = model.encode(messages_to_embed, show_progress_bar=True, batch_size=256)
    elapsed = time.time() - start_time
    
    print(f"Generated embeddings in {elapsed:.1f} seconds.")
    print(f"Embedding shape: {embeddings.shape}")
    
    # Save the embeddings array
    np.save(out_path, embeddings)
    print(f"Saved embeddings to {out_path}.npy")
    
    # Since the alerts are exactly aligned with the embeddings array (index for index),
    # we don't need to bloat the CSV. We can just load both side-by-side during clustering.
    return len(alerts)

if __name__ == '__main__':
    os.chdir(os.path.dirname(os.path.abspath(__file__)))
    
    if not os.path.exists('demo_alerts.csv'):
        print("Error: demo_alerts.csv not found. Run clean_text.py first.")
        exit(1)
        
    embed_messages('demo_alerts.csv', 'demo_embeddings')
    print("Done! Ready for clustering.")
