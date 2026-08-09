import firebase_admin
from firebase_admin import firestore


def get_firestore_client():
    try:
        app = firebase_admin.get_app()
    except ValueError:
        app = firebase_admin.initialize_app()

    return firestore.client(app=app)