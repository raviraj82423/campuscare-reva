
import os
from pathlib import Path

from flask import Flask, jsonify
from flask_cors import CORS
from dotenv import load_dotenv
from flask_jwt_extended import JWTManager

from auth import auth_bp
from complaints import complaints_bp

BASE_DIR = Path(__file__).resolve().parent.parent
load_dotenv(BASE_DIR / ".env")

app = Flask(__name__)

CORS(
    app,
    origins=["http://localhost:3000", "http://127.0.0.1:3000"],
    allow_headers=["Content-Type", "Authorization"],
    methods=["GET", "POST", "PATCH", "OPTIONS"]
)

app.config["JWT_SECRET_KEY"] = os.environ["JWT_SECRET_KEY"]
app.config["MAX_CONTENT_LENGTH"] = 5 * 1024 * 1024
app.config["UPLOAD_FOLDER"] = str(Path(app.root_path) / "uploads")

os.makedirs(app.config["UPLOAD_FOLDER"], exist_ok=True)

JWTManager(app)

app.register_blueprint(auth_bp)
app.register_blueprint(complaints_bp)


@app.route("/")
def home():
    return jsonify({
        "project": "CampusCare",
        "message": "Flask backend is running"
    })


@app.route("/api/health")
def health():
    return jsonify({"status": "healthy"})


@app.errorhandler(413)
def file_too_large(error):
    return jsonify({"error": "Maximum upload size is 5 MB"}), 413


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5000, debug=False)
