import sys
import os
import numpy as np

# Add the data directory to path so we can import the pipeline scripts directly
sys.path.append(os.path.join(os.path.dirname(__file__), '../data'))

from clean_text import clean_full_dataset
from embed_alerts import embed_messages
from cluster_alerts import (
    load_alerts,
    load_embeddings,
    l2_normalize,
    build_clusters,
    build_incident
)


def run_full_pipeline(uploaded_csv_path: str, output_dir: str):
    """
    Orchestrates the entire AI pipeline on a newly uploaded file.
    Returns the final incidents list and the total number of raw alerts processed.
    """
    print(f"Orchestrator starting on: {uploaded_csv_path}")
    
    cleaned_csv_path = os.path.join(output_dir, "upload_cleaned.csv")
    embed_npy_path = os.path.join(output_dir, "upload_embeddings.npy")
    
    # Step 1: Clean the raw log messages (strip IPs, numbers, etc.)
    print("Step 1: Cleaning text...")
    clean_full_dataset(uploaded_csv_path, cleaned_csv_path)
    
    # Step 2: Generate Vector Embeddings via sentence-transformers
    print("Step 2: Generating AI embeddings...")
    embed_messages(cleaned_csv_path, embed_npy_path, model_name='all-MiniLM-L6-v2')
    
    # Step 3: Cluster alerts into incidents based on time window and similarity
    print("Step 3: Clustering alerts...")
    emb_full = np.load(embed_npy_path)
    alerts, kept = load_alerts(cleaned_csv_path, expected_embedding_count=emb_full.shape[0])
    
    if not alerts:
        raise ValueError("No valid alerts survived the cleaning process.")
        
    emb = load_embeddings(embed_npy_path, kept)
    emb_norm = l2_normalize(emb)
    
    # Ensure they are sorted by timestamp (required by the sliding window algo)
    order = sorted(range(len(alerts)), key=lambda i: alerts[i]['timestamp'])
    alerts = [alerts[i] for i in order]
    emb_norm = emb_norm[order]
    
    # Run the sliding-window union-find
    clusters = build_clusters(alerts, emb_norm, window_sec=240, sim_threshold=0.85)
    
    # Step 4: Assemble Incident JSON objects
    incidents = []
    for n, (_, members) in enumerate(clusters.items(), start=1):
        inc, root_idx = build_incident(n, members, alerts, emb_norm)
        # Strip internal key
        inc.pop('_root_idx', None)
        incidents.append(inc)
        
    print(f"Orchestrator finished: Reduced {len(alerts)} alerts down to {len(incidents)} incidents.")
    return incidents, len(alerts)
