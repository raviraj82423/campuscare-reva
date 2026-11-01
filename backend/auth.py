
from flask import Blueprint, request, jsonify
from flask_jwt_extended import create_access_token, get_jwt_identity, jwt_required
from werkzeug.security import generate_password_hash, check_password_hash
from mysql.connector import IntegrityError
from db import get_db_connection

auth_bp = Blueprint("auth", __name__, url_prefix="/api")


@auth_bp.route("/register", methods=["POST"])
def register():
    data = request.get_json(silent=True) or {}
    name = str(data.get("name", "")).strip()
    email = str(data.get("email", "")).strip().lower()
    password = str(data.get("password", ""))

    if not name or not email or len(password) < 8:
        return jsonify({
            "error": "Name, email and password of at least 8 characters are required"
        }), 400

    conn = None
    cursor = None

    try:
        conn = get_db_connection()
        cursor = conn.cursor()

        cursor.execute(
            """INSERT INTO users (name, email, password_hash, role)
               VALUES (%s, %s, %s, 'student')""",
            (name, email, generate_password_hash(password))
        )
        conn.commit()
        return jsonify({"message": "Registration successful"}), 201

    except IntegrityError:
        if conn:
            conn.rollback()
        return jsonify({"error": "Email is already registered"}), 409

    except Exception:
        if conn:
            conn.rollback()
        return jsonify({"error": "Registration failed; check database configuration"}), 500

    finally:
        if cursor:
            cursor.close()
        if conn:
            conn.close()


@auth_bp.route("/login", methods=["POST"])
def login():
    data = request.get_json(silent=True) or {}
    email = str(data.get("email", "")).strip().lower()
    password = str(data.get("password", ""))

    if not email or not password:
        return jsonify({"error": "Email and password are required"}), 400

    conn = None
    cursor = None

    try:
        conn = get_db_connection()
        cursor = conn.cursor(dictionary=True)
        cursor.execute(
            "SELECT id, name, email, password_hash, role FROM users WHERE email = %s",
            (email,)
        )
        user = cursor.fetchone()

        if not user or not check_password_hash(user["password_hash"], password):
            return jsonify({"error": "Invalid email or password"}), 401

        token = create_access_token(
            identity=str(user["id"]),
            additional_claims={"role": user["role"]}
        )

        return jsonify({
            "message": "Login successful",
            "access_token": token,
            "user": {
                "id": user["id"],
                "name": user["name"],
                "email": user["email"],
                "role": user["role"]
            }
        }), 200

    except Exception:
        return jsonify({"error": "Login failed; check database configuration"}), 500

    finally:
        if cursor:
            cursor.close()
        if conn:
            conn.close()


@auth_bp.route("/me", methods=["GET"])
@jwt_required()
def me():
    conn = None
    cursor = None

    try:
        conn = get_db_connection()
        cursor = conn.cursor(dictionary=True)
        cursor.execute(
            "SELECT id, name, email, role FROM users WHERE id = %s",
            (get_jwt_identity(),)
        )
        user = cursor.fetchone()

        if not user:
            return jsonify({"error": "User not found"}), 404

        return jsonify({"user": user}), 200

    except Exception:
        return jsonify({"error": "Could not retrieve profile"}), 500

    finally:
        if cursor:
            cursor.close()
        if conn:
            conn.close()
