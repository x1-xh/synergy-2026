import os
from dotenv import load_dotenv
from openai import OpenAI

# Load the .env file explicitly
load_dotenv(os.path.join(os.path.dirname(__file__), '../backend/.env'))
api_key = os.getenv("NVIDIA_API_KEY")

# Create OpenAI client configured for Nvidia NIM
if api_key:
    client = OpenAI(
        api_key=api_key,
        base_url="https://integrate.api.nvidia.com/v1"
    )
else:
    client = None


def generate_incident_explanation(incident: dict) -> str:
    """
    Takes a single incident object, formats the top-3 root cause candidates 
    into a prompt, and calls the Nvidia NIM LLM for a plain-English explanation.
    """
    fallback = "Anomalous cluster detected autonomously by ClarityOps vector similarity engine."

    if not client:
        return fallback

    candidates = incident.get('root_cause_candidates', [])
    if not candidates:
        return fallback

    # Build a timeline string from the top 3 candidates
    alerts_text = []
    for c in candidates:
        time = c.get('timestamp', '')[11:19]
        sev = c.get('severity', 'INFO')
        service = c.get('service', 'unknown')
        msg = c.get('message', '')
        alerts_text.append(f"[{time}] {sev} ({service}): {msg}")

    timeline_str = "\n".join(alerts_text)

    prompt = f"""You are an expert Site Reliability Engineer analyzing a cluster of alerts. 
Below are the top {len(candidates)} root cause alerts extracted from the incident cluster:

{timeline_str}

In exactly 2 concise sentences, explain what the root cause likely is and what failed. 
Use plain English. Do not hallucinate details not present in the logs.
"""

    try:
        completion = client.chat.completions.create(
            model="meta/llama-3.1-8b-instruct",
            messages=[{"role": "user", "content": prompt}],
            temperature=0.2,
            max_tokens=150,
        )
        explanation = completion.choices[0].message.content.strip()
        return explanation if explanation else fallback
    except Exception as e:
        print(f"LLM generation error: {e}")
        return fallback
