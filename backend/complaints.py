
import os
import uuid
from pathlib import Path

from flask import Blueprint, request, jsonify, current_app, send_from_directory
from flask_jwt_extended import get_jwt, get_jwt_identity, jwt_required
from db import get_db_connection

complaints_bp = Blueprint("complaints", __name__, url_prefix="/api")

CATEGORY_DEPARTMENTS = {
    "Wi-Fi": "IT Department",
    "Wi-Fi/Internet": "IT Department",
    "Infrastructure": "Maintenance Department",
    "Cleanliness": "Housekeeping Department",
    "Housekeeping": "Housekeeping Department",
    "Transport": "Transport Department",
    "Hostel": "Hostel Administration",
    "Library": "Library Administration",
    "Security/Safety": "Security Office",
    "Water/Washroom": "Maintenance Department",
    "Other": "General Administration"
}

ALLOWED_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp"}
ALLOWED_STATUSES = {"Assigned", "In Progress", "Resolved", "Closed"}


def is_admin():
    return get_jwt().get("role") == "admin"


@complaints_bp.route("/complaints", methods=["POST"])
@jwt_required()
def submit_complaint():
    data = request.form if request.content_type and "multipart/form-data" in request.content_type else (request.get_json(silent=True) or {})

    title = str(data.get("title", "")).strip()
    description = str(data.get("description", "")).strip()
    category = str(data.get("category", "")).strip()
    location = str(data.get("location", "")).strip()

    if not all([title, description, category, location]):
        return jsonify({"error": "Title, description, category and location are required"}), 400

    user_id = get_jwt_identity()
    conn = None
    cursor = None
    saved_image = None

    try:
        upload = request.files.get("image")

        if upload and upload.filename:
            ext = Path(upload.filename).suffix.lower()
            if ext not in ALLOWED_EXTENSIONS:
                return jsonify({"error": "Image must be PNG, JPG, JPEG or WEBP"}), 400

            saved_image = uuid.uuid4().hex + ext
            upload.save(os.path.join(current_app.config["UPLOAD_FOLDER"], saved_image))

        conn = get_db_connection()
        cursor = conn.cursor(dictionary=True)

        department = CATEGORY_DEPARTMENTS.get(category, "General Administration")
        cursor.execute("SELECT id FROM departments WHERE name = %s", (department,))
        row = cursor.fetchone()
        department_id = row["id"] if row else None

        ticket_id = "CMP-" + uuid.uuid4().hex[:10].upper()

        cursor.execute(
            """
            INSERT INTO complaints
            (ticket_id, user_id, title, description, category, location,
             image_path, department_id, status, created_at, updated_at)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, 'Submitted', NOW(), NOW())
            """,
            (ticket_id, user_id, title, description, category, location,
             saved_image, department_id)
        )

        complaint_id = cursor.lastrowid

        cursor.execute(
            """
            INSERT INTO complaint_history
            (complaint_id, old_status, new_status, updated_by, remarks, created_at)
            VALUES (%s, NULL, 'Submitted', %s, 'Complaint submitted', NOW())
            """,
            (complaint_id, user_id)
        )

        conn.commit()
        return jsonify({"message": "Complaint submitted successfully", "ticket_id": ticket_id}), 201

    except Exception:
        if conn:
            conn.rollback()
        if saved_image:
            try:
                os.remove(os.path.join(current_app.config["UPLOAD_FOLDER"], saved_image))
            except OSError:
                pass
        return jsonify({"error": "Could not submit complaint; check database schema"}), 500

    finally:
        if cursor:
            cursor.close()
        if conn:
            conn.close()


@complaints_bp.route("/my-complaints", methods=["GET"])
@jwt_required()
def my_complaints():
    conn = None
    cursor = None

    try:
        conn = get_db_connection()
        cursor = conn.cursor(dictionary=True)
        cursor.execute(
            """
            SELECT c.ticket_id, c.title, c.description, c.category,
                   c.location, c.status, c.created_at, c.updated_at,
                   d.name AS department
            FROM complaints c
            LEFT JOIN departments d ON c.department_id = d.id
            WHERE c.user_id = %s
            ORDER BY c.created_at DESC
            """,
            (get_jwt_identity(),)
        )
        return jsonify({"complaints": cursor.fetchall()}), 200

    except Exception:
        return jsonify({"error": "Could not retrieve complaints"}), 500

    finally:
        if cursor:
            cursor.close()
        if conn:
            conn.close()


@complaints_bp.route("/complaints", methods=["GET"])
@jwt_required()
def all_complaints():
    if not is_admin():
        return jsonify({"error": "Administrator access required"}), 403

    conn = None
    cursor = None

    try:
        conn = get_db_connection()
        cursor = conn.cursor(dictionary=True)
        cursor.execute(
            """
            SELECT c.ticket_id, c.title, c.description, c.category,
                   c.location, c.status, c.created_at, c.updated_at,
                   u.name AS student_name, u.email,
                   d.name AS department
            FROM complaints c
            JOIN users u ON c.user_id = u.id
            LEFT JOIN departments d ON c.department_id = d.id
            ORDER BY c.created_at DESC
            """
        )
        return jsonify({"complaints": cursor.fetchall()}), 200

    except Exception:
        return jsonify({"error": "Could not retrieve complaints"}), 500

    finally:
        if cursor:
            cursor.close()
        if conn:
            conn.close()


@complaints_bp.route("/complaints/<ticket_id>", methods=["GET"])
@jwt_required()
def complaint_details(ticket_id):
    conn = None
    cursor = None

    try:
        conn = get_db_connection()
        cursor = conn.cursor(dictionary=True)
        cursor.execute(
            """
            SELECT c.*, d.name AS department
            FROM complaints c
            LEFT JOIN departments d ON c.department_id = d.id
            WHERE c.ticket_id = %s
            """,
            (ticket_id,)
        )
        complaint = cursor.fetchone()

        if not complaint:
            return jsonify({"error": "Complaint not found"}), 404

        if not is_admin() and str(complaint["user_id"]) != str(get_jwt_identity()):
            return jsonify({"error": "Access denied"}), 403

        cursor.execute(
            """
            SELECT old_status, new_status, remarks, created_at
            FROM complaint_history
            WHERE complaint_id = %s
            ORDER BY created_at
            """,
            (complaint["id"],)
        )
        complaint["history"] = cursor.fetchall()
        return jsonify(complaint), 200

    except Exception:
        return jsonify({"error": "Could not retrieve complaint"}), 500

    finally:
        if cursor:
            cursor.close()
        if conn:
            conn.close()


@complaints_bp.route("/complaints/<ticket_id>/status", methods=["PATCH"])
@jwt_required()
def update_status(ticket_id):
    if not is_admin():
        return jsonify({"error": "Administrator access required"}), 403

    data = request.get_json(silent=True) or {}
    new_status = str(data.get("status", "")).strip()
    remarks = str(data.get("remarks", "")).strip()

    if new_status not in ALLOWED_STATUSES:
        return jsonify({"error": "Invalid status"}), 400

    conn = None
    cursor = None

    try:
        conn = get_db_connection()
        cursor = conn.cursor(dictionary=True)
        cursor.execute("SELECT id, status FROM complaints WHERE ticket_id = %s", (ticket_id,))
        complaint = cursor.fetchone()

        if not complaint:
            return jsonify({"error": "Complaint not found"}), 404

        cursor.execute(
            "UPDATE complaints SET status = %s, updated_at = NOW() WHERE id = %s",
            (new_status, complaint["id"])
        )
        cursor.execute(
            """
            INSERT INTO complaint_history
            (complaint_id, old_status, new_status, updated_by, remarks, created_at)
            VALUES (%s, %s, %s, %s, %s, NOW())
            """,
            (complaint["id"], complaint["status"], new_status, get_jwt_identity(), remarks)
        )
        conn.commit()
        return jsonify({"message": "Status updated", "ticket_id": ticket_id, "status": new_status}), 200

    except Exception:
        if conn:
            conn.rollback()
        return jsonify({"error": "Could not update status"}), 500

    finally:
        if cursor:
            cursor.close()
        if conn:
            conn.close()


@complaints_bp.route("/complaints/<ticket_id>/image", methods=["GET"])
@jwt_required()
def complaint_image(ticket_id):
    conn = None
    cursor = None

    try:
        conn = get_db_connection()
        cursor = conn.cursor(dictionary=True)
        cursor.execute(
            "SELECT user_id, image_path FROM complaints WHERE ticket_id = %s",
            (ticket_id,)
        )
        complaint = cursor.fetchone()

        if not complaint or not complaint["image_path"]:
            return jsonify({"error": "Image not found"}), 404

        if not is_admin() and str(complaint["user_id"]) != str(get_jwt_identity()):
            return jsonify({"error": "Access denied"}), 403

        return send_from_directory(
            current_app.config["UPLOAD_FOLDER"],
            complaint["image_path"]
        )

    except Exception:
        return jsonify({"error": "Could not retrieve image"}), 500

    finally:
        if cursor:
            cursor.close()
        if conn:
            conn.close()
