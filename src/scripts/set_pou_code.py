import sys, scriptengine as script_engine, os, traceback

POU_FULL_PATH = "{POU_FULL_PATH}" # Expecting format like "Application/MyPOU" or "Folder/SubFolder/MyPOU"
DECLARATION_CONTENT = """{DECLARATION_CONTENT}"""
IMPLEMENTATION_CONTENT = """{IMPLEMENTATION_CONTENT}"""
UPDATE_DECL_FLAG = "{UPDATE_DECL}"  # "1" if caller passed declarationCode, "0" if omitted/empty
UPDATE_IMPL_FLAG = "{UPDATE_IMPL}"  # "1" if caller passed implementationCode, "0" if omitted/empty

try:
    _safe_print("set_pou_code for:", POU_FULL_PATH)
    primary_project = ensure_project_open(PROJECT_FILE_PATH)
    if not POU_FULL_PATH: raise ValueError("POU full path empty.")

    # Find the target POU/Method/Property object
    target_object = find_object_by_path_robust(primary_project, POU_FULL_PATH, "target object")
    if not target_object: raise ValueError("not found: " + POU_FULL_PATH.encode('utf-8'))

    target_name = getattr(target_object, 'get_name', lambda: POU_FULL_PATH)()
    _safe_print("Found target:", target_name)

    # --- Set Declaration Part ---
    declaration_updated = False
    if UPDATE_DECL_FLAG == "1":
        if hasattr(target_object, 'textual_declaration'):
            decl_obj = target_object.textual_declaration
            if decl_obj and hasattr(decl_obj, 'replace'):
                try:
                    decl_obj.replace(_to_unicode(DECLARATION_CONTENT))
                    declaration_updated = True
                except Exception as decl_err:
                    _safe_print("set_pou_code: declaration set error:", repr(decl_err))
            else:
                 pass
        else:
            pass
    else:
         pass

    # --- Set Implementation Part ---
    implementation_updated = False
    if UPDATE_IMPL_FLAG == "1":
        if hasattr(target_object, 'textual_implementation'):
            impl_obj = target_object.textual_implementation
            if impl_obj and hasattr(impl_obj, 'replace'):
                try:
                    impl_obj.replace(_to_unicode(IMPLEMENTATION_CONTENT))
                    implementation_updated = True
                except Exception as impl_err:
                     _safe_print("set_pou_code: implementation set error:", repr(impl_err))
            else:
                 pass
        else:
            pass
    else:
        pass

    # --- SAVE THE PROJECT TO PERSIST THE CODE CHANGE ---
    if declaration_updated or implementation_updated:
        try:
            primary_project.save()
        except Exception as save_err:
            _safe_print("set_pou_code: save error:", repr(save_err))
            sys.exit(1)
    # --- END SAVING ---

    sys.stdout.write("SCRIPT_SUCCESS\n")
    sys.exit(0)

except Exception as e:
    _safe_print("set_pou_code error:", repr(e))
    sys.exit(1)
