use std::collections::{BTreeSet, HashMap, HashSet};
use std::ffi::{CStr, CString};
use std::fs::{File, OpenOptions};
use std::io::{Read, Write};
use std::os::raw::c_char;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::ptr;
use std::sync::OnceLock;

use libloading::Library;
use sha2::Digest;

use lib3mf_ffi::{
    eModelUnit, eObjectType, sColor, sPosition, sTransform, sTriangle, sTriangleProperties, CBool,
    Lib3MF_Base, Lib3MF_BuildItem, Lib3MF_ComponentsObject, Lib3MF_MeshObject, Lib3MF_Model,
    Lib3MF_Object, Lib3MF_Reader,
};

use crate::geometry::Aabb;
use crate::limits::ParseGuard;
use crate::scene_status::SceneLoadStatus;
use crate::threemf::{
    ThreeMfError, ThreeMfMesh, ThreeMfPart, MAX_COMPONENT_DEPTH, MAX_TRIANGLES, MAX_VERTICES,
};

pub fn parse_file(path: &Path) -> Result<ThreeMfMesh, ThreeMfError> {
    let mut guard = ParseGuard::default();
    let mesh = crate::threemf::parse_file_with_guard(path, &mut guard)?;
    let (validated, failure_kind) = match Lib3mfSession::new() {
        Ok(session) => (
            session.parse_file(path),
            NativeValidationFailureKind::ValidationFailed,
        ),
        Err(error) => (
            Err(error),
            NativeValidationFailureKind::ValidatorUnavailable,
        ),
    };
    guard.check_now()?;
    merge_or_fallback(mesh, validated, failure_kind, &mut guard)
}

pub fn parse_bytes(data: &[u8]) -> Result<ThreeMfMesh, ThreeMfError> {
    let mut guard = ParseGuard::default();
    let mesh = crate::threemf::parse_bytes_with_guard(data, &mut guard)?;
    let (validated, failure_kind) = match Lib3mfSession::new() {
        Ok(session) => (
            session.parse_bytes(data),
            NativeValidationFailureKind::ValidationFailed,
        ),
        Err(error) => (
            Err(error),
            NativeValidationFailureKind::ValidatorUnavailable,
        ),
    };
    guard.check_now()?;
    merge_or_fallback(mesh, validated, failure_kind, &mut guard)
}

struct LoadedLib3mfApi {
    lib3mf_basematerialgroup_getcount:
        unsafe extern "C" fn(lib3mf_ffi::Lib3MF_BaseMaterialGroup, *mut u32) -> i32,
    lib3mf_basematerialgroup_getdisplaycolor:
        unsafe extern "C" fn(lib3mf_ffi::Lib3MF_BaseMaterialGroup, u32, *mut sColor) -> i32,
    lib3mf_basematerialgroup_getname: unsafe extern "C" fn(
        lib3mf_ffi::Lib3MF_BaseMaterialGroup,
        u32,
        u32,
        *mut u32,
        *mut c_char,
    ) -> i32,
    lib3mf_basematerialgroupiterator_getcurrentbasematerialgroup: unsafe extern "C" fn(
        lib3mf_ffi::Lib3MF_BaseMaterialGroupIterator,
        *mut lib3mf_ffi::Lib3MF_BaseMaterialGroup,
    ) -> i32,
    lib3mf_builditem_getobjectresource:
        unsafe extern "C" fn(Lib3MF_BuildItem, *mut Lib3MF_Object) -> i32,
    lib3mf_builditem_getobjecttransform:
        unsafe extern "C" fn(Lib3MF_BuildItem, *mut sTransform) -> i32,
    lib3mf_builditem_getpartnumber:
        unsafe extern "C" fn(Lib3MF_BuildItem, u32, *mut u32, *mut c_char) -> i32,
    lib3mf_builditem_hasobjecttransform: unsafe extern "C" fn(Lib3MF_BuildItem, *mut CBool) -> i32,
    lib3mf_builditemiterator_getcurrent:
        unsafe extern "C" fn(lib3mf_ffi::Lib3MF_BuildItemIterator, *mut Lib3MF_BuildItem) -> i32,
    lib3mf_builditemiterator_movenext:
        unsafe extern "C" fn(lib3mf_ffi::Lib3MF_BuildItemIterator, *mut CBool) -> i32,
    lib3mf_component_getobjectresource:
        unsafe extern "C" fn(lib3mf_ffi::Lib3MF_Component, *mut Lib3MF_Object) -> i32,
    lib3mf_component_gettransform:
        unsafe extern "C" fn(lib3mf_ffi::Lib3MF_Component, *mut sTransform) -> i32,
    lib3mf_component_hastransform:
        unsafe extern "C" fn(lib3mf_ffi::Lib3MF_Component, *mut CBool) -> i32,
    lib3mf_componentsobject_getcomponent: unsafe extern "C" fn(
        Lib3MF_ComponentsObject,
        u32,
        *mut lib3mf_ffi::Lib3MF_Component,
    ) -> i32,
    lib3mf_componentsobject_getcomponentcount:
        unsafe extern "C" fn(Lib3MF_ComponentsObject, *mut u32) -> i32,
    lib3mf_createmodel: unsafe extern "C" fn(*mut Lib3MF_Model) -> i32,
    lib3mf_getlasterror:
        unsafe extern "C" fn(Lib3MF_Base, u32, *mut u32, *mut c_char, *mut CBool) -> i32,
    lib3mf_meshobject_getalltriangleproperties:
        unsafe extern "C" fn(Lib3MF_MeshObject, u64, *mut u64, *mut sTriangleProperties) -> i32,
    lib3mf_meshobject_gettrianglecount: unsafe extern "C" fn(Lib3MF_MeshObject, *mut u32) -> i32,
    lib3mf_meshobject_gettriangleindices:
        unsafe extern "C" fn(Lib3MF_MeshObject, u64, *mut u64, *mut sTriangle) -> i32,
    lib3mf_meshobject_getvertexcount: unsafe extern "C" fn(Lib3MF_MeshObject, *mut u32) -> i32,
    lib3mf_meshobject_getvertices:
        unsafe extern "C" fn(Lib3MF_MeshObject, u64, *mut u64, *mut sPosition) -> i32,
    lib3mf_model_getbasematerialgroups: unsafe extern "C" fn(
        Lib3MF_Model,
        *mut lib3mf_ffi::Lib3MF_BaseMaterialGroupIterator,
    ) -> i32,
    lib3mf_model_getbuilditems:
        unsafe extern "C" fn(Lib3MF_Model, *mut lib3mf_ffi::Lib3MF_BuildItemIterator) -> i32,
    lib3mf_model_getcomponentsobjectbyid:
        unsafe extern "C" fn(Lib3MF_Model, u32, *mut Lib3MF_ComponentsObject) -> i32,
    lib3mf_model_getmeshobjectbyid:
        unsafe extern "C" fn(Lib3MF_Model, u32, *mut Lib3MF_MeshObject) -> i32,
    lib3mf_model_getobjects:
        unsafe extern "C" fn(Lib3MF_Model, *mut lib3mf_ffi::Lib3MF_ObjectIterator) -> i32,
    lib3mf_model_getunit: unsafe extern "C" fn(Lib3MF_Model, *mut eModelUnit) -> i32,
    lib3mf_model_queryreader:
        unsafe extern "C" fn(Lib3MF_Model, *const c_char, *mut Lib3MF_Reader) -> i32,
    lib3mf_object_getname: unsafe extern "C" fn(Lib3MF_Object, u32, *mut u32, *mut c_char) -> i32,
    lib3mf_object_getpartnumber:
        unsafe extern "C" fn(Lib3MF_Object, u32, *mut u32, *mut c_char) -> i32,
    lib3mf_object_gettype: unsafe extern "C" fn(Lib3MF_Object, *mut eObjectType) -> i32,
    lib3mf_object_iscomponentsobject: unsafe extern "C" fn(Lib3MF_Object, *mut CBool) -> i32,
    lib3mf_object_islevelsetobject: unsafe extern "C" fn(Lib3MF_Object, *mut CBool) -> i32,
    lib3mf_object_ismeshobject: unsafe extern "C" fn(Lib3MF_Object, *mut CBool) -> i32,
    lib3mf_objectiterator_getcurrentobject:
        unsafe extern "C" fn(lib3mf_ffi::Lib3MF_ObjectIterator, *mut Lib3MF_Object) -> i32,
    lib3mf_reader_readfrombuffer: unsafe extern "C" fn(Lib3MF_Reader, u64, *const u8) -> i32,
    lib3mf_reader_readfromfile: unsafe extern "C" fn(Lib3MF_Reader, *const c_char) -> i32,
    lib3mf_release: unsafe extern "C" fn(Lib3MF_Base) -> i32,
    lib3mf_resource_getresourceid:
        unsafe extern "C" fn(lib3mf_ffi::Lib3MF_Resource, *mut u32) -> i32,
    lib3mf_resourceiterator_movenext:
        unsafe extern "C" fn(lib3mf_ffi::Lib3MF_ResourceIterator, *mut CBool) -> i32,
}

impl LoadedLib3mfApi {
    unsafe fn load(library: &Library) -> Result<Self, String> {
        unsafe fn load_symbol<T: Copy>(library: &Library, symbol: &[u8]) -> Result<T, String> {
            Ok(*unsafe { library.get::<T>(symbol) }.map_err(|error| {
                format!(
                    "failed to load lib3mf export {}: {error}",
                    String::from_utf8_lossy(&symbol[..symbol.len().saturating_sub(1)])
                )
            })?)
        }

        Ok(Self {
            lib3mf_basematerialgroup_getcount: unsafe {
                load_symbol(library, b"lib3mf_basematerialgroup_getcount\0")
            }?,
            lib3mf_basematerialgroup_getdisplaycolor: unsafe {
                load_symbol(library, b"lib3mf_basematerialgroup_getdisplaycolor\0")
            }?,
            lib3mf_basematerialgroup_getname: unsafe {
                load_symbol(library, b"lib3mf_basematerialgroup_getname\0")
            }?,
            lib3mf_basematerialgroupiterator_getcurrentbasematerialgroup: unsafe {
                load_symbol(
                    library,
                    b"lib3mf_basematerialgroupiterator_getcurrentbasematerialgroup\0",
                )
            }?,
            lib3mf_builditem_getobjectresource: unsafe {
                load_symbol(library, b"lib3mf_builditem_getobjectresource\0")
            }?,
            lib3mf_builditem_getobjecttransform: unsafe {
                load_symbol(library, b"lib3mf_builditem_getobjecttransform\0")
            }?,
            lib3mf_builditem_getpartnumber: unsafe {
                load_symbol(library, b"lib3mf_builditem_getpartnumber\0")
            }?,
            lib3mf_builditem_hasobjecttransform: unsafe {
                load_symbol(library, b"lib3mf_builditem_hasobjecttransform\0")
            }?,
            lib3mf_builditemiterator_getcurrent: unsafe {
                load_symbol(library, b"lib3mf_builditemiterator_getcurrent\0")
            }?,
            lib3mf_builditemiterator_movenext: unsafe {
                load_symbol(library, b"lib3mf_builditemiterator_movenext\0")
            }?,
            lib3mf_component_getobjectresource: unsafe {
                load_symbol(library, b"lib3mf_component_getobjectresource\0")
            }?,
            lib3mf_component_gettransform: unsafe {
                load_symbol(library, b"lib3mf_component_gettransform\0")
            }?,
            lib3mf_component_hastransform: unsafe {
                load_symbol(library, b"lib3mf_component_hastransform\0")
            }?,
            lib3mf_componentsobject_getcomponent: unsafe {
                load_symbol(library, b"lib3mf_componentsobject_getcomponent\0")
            }?,
            lib3mf_componentsobject_getcomponentcount: unsafe {
                load_symbol(library, b"lib3mf_componentsobject_getcomponentcount\0")
            }?,
            lib3mf_createmodel: unsafe { load_symbol(library, b"lib3mf_createmodel\0") }?,
            lib3mf_getlasterror: unsafe { load_symbol(library, b"lib3mf_getlasterror\0") }?,
            lib3mf_meshobject_getalltriangleproperties: unsafe {
                load_symbol(library, b"lib3mf_meshobject_getalltriangleproperties\0")
            }?,
            lib3mf_meshobject_gettrianglecount: unsafe {
                load_symbol(library, b"lib3mf_meshobject_gettrianglecount\0")
            }?,
            lib3mf_meshobject_gettriangleindices: unsafe {
                load_symbol(library, b"lib3mf_meshobject_gettriangleindices\0")
            }?,
            lib3mf_meshobject_getvertexcount: unsafe {
                load_symbol(library, b"lib3mf_meshobject_getvertexcount\0")
            }?,
            lib3mf_meshobject_getvertices: unsafe {
                load_symbol(library, b"lib3mf_meshobject_getvertices\0")
            }?,
            lib3mf_model_getbasematerialgroups: unsafe {
                load_symbol(library, b"lib3mf_model_getbasematerialgroups\0")
            }?,
            lib3mf_model_getbuilditems: unsafe {
                load_symbol(library, b"lib3mf_model_getbuilditems\0")
            }?,
            lib3mf_model_getcomponentsobjectbyid: unsafe {
                load_symbol(library, b"lib3mf_model_getcomponentsobjectbyid\0")
            }?,
            lib3mf_model_getmeshobjectbyid: unsafe {
                load_symbol(library, b"lib3mf_model_getmeshobjectbyid\0")
            }?,
            lib3mf_model_getobjects: unsafe { load_symbol(library, b"lib3mf_model_getobjects\0") }?,
            lib3mf_model_getunit: unsafe { load_symbol(library, b"lib3mf_model_getunit\0") }?,
            lib3mf_model_queryreader: unsafe {
                load_symbol(library, b"lib3mf_model_queryreader\0")
            }?,
            lib3mf_object_getname: unsafe { load_symbol(library, b"lib3mf_object_getname\0") }?,
            lib3mf_object_getpartnumber: unsafe {
                load_symbol(library, b"lib3mf_object_getpartnumber\0")
            }?,
            lib3mf_object_gettype: unsafe { load_symbol(library, b"lib3mf_object_gettype\0") }?,
            lib3mf_object_iscomponentsobject: unsafe {
                load_symbol(library, b"lib3mf_object_iscomponentsobject\0")
            }?,
            lib3mf_object_islevelsetobject: unsafe {
                load_symbol(library, b"lib3mf_object_islevelsetobject\0")
            }?,
            lib3mf_object_ismeshobject: unsafe {
                load_symbol(library, b"lib3mf_object_ismeshobject\0")
            }?,
            lib3mf_objectiterator_getcurrentobject: unsafe {
                load_symbol(library, b"lib3mf_objectiterator_getcurrentobject\0")
            }?,
            lib3mf_reader_readfrombuffer: unsafe {
                load_symbol(library, b"lib3mf_reader_readfrombuffer\0")
            }?,
            lib3mf_reader_readfromfile: unsafe {
                load_symbol(library, b"lib3mf_reader_readfromfile\0")
            }?,
            lib3mf_release: unsafe { load_symbol(library, b"lib3mf_release\0") }?,
            lib3mf_resource_getresourceid: unsafe {
                load_symbol(library, b"lib3mf_resource_getresourceid\0")
            }?,
            lib3mf_resourceiterator_movenext: unsafe {
                load_symbol(library, b"lib3mf_resourceiterator_movenext\0")
            }?,
        })
    }
}

struct LoadedLib3mf {
    _library: Library,
    api: LoadedLib3mfApi,
}

impl LoadedLib3mf {
    fn new(library_path: &str) -> Result<Self, String> {
        let library = unsafe { Library::new(library_path) }.map_err(|error| {
            format!("failed to load lib3mf shared library {library_path}: {error}")
        })?;
        let api = unsafe { LoadedLib3mfApi::load(&library) }?;
        Ok(Self {
            _library: library,
            api,
        })
    }

    fn api(&self) -> &LoadedLib3mfApi {
        &self.api
    }
}

struct Lib3mfSession {
    wrapper: LoadedLib3mf,
}

impl Lib3mfSession {
    fn new() -> Result<Self, ThreeMfError> {
        let bases = lib3mf_library_bases()?;
        let wrapper = load_wrapper_from_library_bases(&bases, load_wrapper_from_library_base)?;
        Ok(Self { wrapper })
    }

    fn api(&self) -> &LoadedLib3mfApi {
        self.wrapper.api()
    }

    fn parse_file(&self, path: &Path) -> Result<ThreeMfMesh, ThreeMfError> {
        let path_str = path.to_str().ok_or_else(|| {
            ThreeMfError::Lib3Mf("3MF path is not valid UTF-8 for lib3mf".to_string())
        })?;
        let path_cstr = CString::new(path_str).map_err(|_| {
            ThreeMfError::Lib3Mf("3MF path contains an interior NUL byte".to_string())
        })?;

        let model = self.create_model()?;
        let reader = self.query_reader(model.as_model())?;
        self.check(
            reader.raw,
            unsafe {
                (self.api().lib3mf_reader_readfromfile)(reader.as_reader(), path_cstr.as_ptr())
            },
            "ReadFromFile",
        )?;
        self.extract_scene(model.as_model())
    }

    fn parse_bytes(&self, data: &[u8]) -> Result<ThreeMfMesh, ThreeMfError> {
        let byte_count = u64::try_from(data.len()).map_err(|_| ThreeMfError::TooLarge)?;
        let model = self.create_model()?;
        let reader = self.query_reader(model.as_model())?;
        self.check(
            reader.raw,
            unsafe {
                (self.api().lib3mf_reader_readfrombuffer)(
                    reader.as_reader(),
                    byte_count,
                    data.as_ptr(),
                )
            },
            "ReadFromBuffer",
        )?;
        self.extract_scene(model.as_model())
    }

    fn extract_scene(&self, model: Lib3MF_Model) -> Result<ThreeMfMesh, ThreeMfError> {
        let unit = self.model_unit(model)?;
        let object_count = self.count_objects(model)?;
        let materials = self.collect_base_materials(model)?;

        let build_items = self.get_build_items(model)?;
        let mut has_next = 0;
        let mut parts = Vec::new();
        let mut output = MeshOutput::default();

        loop {
            self.check(
                build_items.raw,
                unsafe {
                    (self.api().lib3mf_builditemiterator_movenext)(
                        build_items.as_build_item_iterator(),
                        &mut has_next,
                    )
                },
                "BuildItemIterator::MoveNext",
            )?;
            if has_next == 0 {
                break;
            }

            let build_item = self.current_build_item(build_items.as_build_item_iterator())?;
            let triangle_start = output.triangles.len();
            let build_transform = self.build_item_transform(build_item.as_build_item())?;
            let build_object = self.build_item_object(build_item.as_build_item())?;
            let object_id = self.object_resource_id(build_object.as_object())?;
            let part_number = self.build_item_part_number(build_item.as_build_item())?;
            let name = self.object_display_name(
                build_object.as_object(),
                object_id,
                part_number.as_deref(),
            )?;

            let mut part = PartAccumulator::new(name, triangle_start, part_number);
            self.expand_object(
                model,
                build_object.as_object(),
                build_transform,
                &materials,
                &mut output,
                &mut part,
                0,
            )?;
            part.triangle_count = output.triangles.len().saturating_sub(triangle_start);
            if part.triangle_count == 0 {
                part.note(
                    SceneLoadStatus::Unsupported,
                    format!("build item for object {object_id} did not yield triangle geometry"),
                );
            }
            output.messages.extend(part.messages.iter().cloned());
            parts.push(part.finish());
        }

        if output.vertices.is_empty() || output.triangles.is_empty() {
            return Err(ThreeMfError::Malformed(
                "3MF contains no triangle geometry".to_string(),
            ));
        }

        let status = parts
            .iter()
            .fold(SceneLoadStatus::Complete, |combined, part| {
                combined.combine(part.status)
            });

        Ok(ThreeMfMesh {
            vertices: output.vertices,
            triangles: output.triangles,
            bounds: output.bounds,
            unit,
            object_count,
            build_item_count: parts.len(),
            status,
            status_messages: output.messages.into_iter().collect(),
            parts,
            objects: Vec::new(),
            root_object_ids: Vec::new(),
            plates: Vec::new(),
        })
    }

    #[allow(clippy::too_many_arguments)]
    fn expand_object(
        &self,
        model: Lib3MF_Model,
        object: Lib3MF_Object,
        transform: AffineTransform,
        materials: &MaterialCatalog,
        output: &mut MeshOutput,
        part: &mut PartAccumulator,
        depth: usize,
    ) -> Result<(), ThreeMfError> {
        if depth > MAX_COMPONENT_DEPTH {
            return Err(ThreeMfError::Malformed(
                "component nesting too deep (possible reference cycle)".to_string(),
            ));
        }

        let object_id = self.object_resource_id(object)?;
        let object_type = self.object_type(object)?;
        if object_type != eObjectType::Model {
            part.note(
                SceneLoadStatus::Partial,
                format!("object {object_id} has non-model type {:?}", object_type),
            );
        }

        let mut is_levelset = 0;
        self.check(
            object as Lib3MF_Base,
            unsafe { (self.api().lib3mf_object_islevelsetobject)(object, &mut is_levelset) },
            "Object::IsLevelSetObject",
        )?;
        if is_levelset != 0 {
            part.note(
                SceneLoadStatus::Unsupported,
                format!("object {object_id} is a level-set object"),
            );
            return Ok(());
        }

        let mut is_mesh = 0;
        self.check(
            object as Lib3MF_Base,
            unsafe { (self.api().lib3mf_object_ismeshobject)(object, &mut is_mesh) },
            "Object::IsMeshObject",
        )?;
        if is_mesh != 0 {
            let mesh = self.mesh_object(model, object_id)?;
            self.expand_mesh(
                mesh.as_mesh_object(),
                object_id,
                transform,
                materials,
                output,
                part,
            )?;
            return Ok(());
        }

        let mut is_components = 0;
        self.check(
            object as Lib3MF_Base,
            unsafe { (self.api().lib3mf_object_iscomponentsobject)(object, &mut is_components) },
            "Object::IsComponentsObject",
        )?;
        if is_components == 0 {
            part.note(
                SceneLoadStatus::Unsupported,
                format!("object {object_id} is neither a mesh nor a components object"),
            );
            return Ok(());
        }

        let components = self.components_object(model, object_id)?;
        let mut component_count = 0;
        self.check(
            components.raw,
            unsafe {
                (self.api().lib3mf_componentsobject_getcomponentcount)(
                    components.as_components_object(),
                    &mut component_count,
                )
            },
            "ComponentsObject::GetComponentCount",
        )?;

        for index in 0..component_count {
            let component = self.component(components.as_components_object(), index)?;
            let component_object =
                self.component_object(component.raw as lib3mf_ffi::Lib3MF_Component)?;
            let component_transform =
                self.component_transform(component.raw as lib3mf_ffi::Lib3MF_Component)?;
            self.expand_object(
                model,
                component_object.as_object(),
                component_transform.compose(&transform),
                materials,
                output,
                part,
                depth + 1,
            )?;
        }

        Ok(())
    }

    fn expand_mesh(
        &self,
        mesh: Lib3MF_MeshObject,
        object_id: u32,
        transform: AffineTransform,
        materials: &MaterialCatalog,
        output: &mut MeshOutput,
        part: &mut PartAccumulator,
    ) -> Result<(), ThreeMfError> {
        let mut vertex_count = 0;
        self.check(
            mesh as Lib3MF_Base,
            unsafe { (self.api().lib3mf_meshobject_getvertexcount)(mesh, &mut vertex_count) },
            "MeshObject::GetVertexCount",
        )?;
        let mut triangle_count = 0;
        self.check(
            mesh as Lib3MF_Base,
            unsafe { (self.api().lib3mf_meshobject_gettrianglecount)(mesh, &mut triangle_count) },
            "MeshObject::GetTriangleCount",
        )?;

        let vertex_count_usize =
            usize::try_from(vertex_count).map_err(|_| ThreeMfError::TooLarge)?;
        let triangle_count_usize =
            usize::try_from(triangle_count).map_err(|_| ThreeMfError::TooLarge)?;
        if output.vertices.len() + vertex_count_usize > MAX_VERTICES
            || output.triangles.len() + triangle_count_usize > MAX_TRIANGLES
        {
            return Err(ThreeMfError::TooLarge);
        }

        let mut vertices = vec![
            sPosition {
                Coordinates: [0.0; 3],
            };
            vertex_count_usize
        ];
        let mut needed_vertices = 0u64;
        self.check(
            mesh as Lib3MF_Base,
            unsafe {
                (self.api().lib3mf_meshobject_getvertices)(
                    mesh,
                    u64::from(vertex_count),
                    &mut needed_vertices,
                    vertices.as_mut_ptr(),
                )
            },
            "MeshObject::GetVertices",
        )?;

        let mut triangles = vec![sTriangle { Indices: [0; 3] }; triangle_count_usize];
        let mut needed_triangles = 0u64;
        self.check(
            mesh as Lib3MF_Base,
            unsafe {
                (self.api().lib3mf_meshobject_gettriangleindices)(
                    mesh,
                    u64::from(triangle_count),
                    &mut needed_triangles,
                    triangles.as_mut_ptr(),
                )
            },
            "MeshObject::GetTriangleIndices",
        )?;

        let triangle_properties = self.mesh_triangle_properties(mesh, triangle_count)?;
        self.apply_material_observations(materials, &triangle_properties, part);

        let base = u32::try_from(output.vertices.len()).map_err(|_| ThreeMfError::TooLarge)?;
        for vertex in vertices {
            let transformed = transform.apply(vertex.Coordinates);
            output.bounds.expand(transformed);
            output.vertices.push(transformed);
        }

        for triangle in triangles {
            for index in triangle.Indices {
                if usize::try_from(index)
                    .ok()
                    .is_none_or(|resolved| resolved >= vertex_count_usize)
                {
                    return Err(ThreeMfError::Malformed(format!(
                        "triangle index {index} out of range in object {object_id}"
                    )));
                }
            }
            output.triangles.push([
                base + triangle.Indices[0],
                base + triangle.Indices[1],
                base + triangle.Indices[2],
            ]);
        }

        Ok(())
    }

    fn apply_material_observations(
        &self,
        materials: &MaterialCatalog,
        properties: &[sTriangleProperties],
        part: &mut PartAccumulator,
    ) {
        let mut local_materials = BTreeSet::new();
        for property in properties {
            if property.ResourceID == 0 {
                continue;
            }
            if property.PropertyIDs[0] != property.PropertyIDs[1]
                || property.PropertyIDs[1] != property.PropertyIDs[2]
            {
                part.note(
                    SceneLoadStatus::Partial,
                    format!(
                        "resource {} uses per-corner triangle properties that are not flattened",
                        property.ResourceID
                    ),
                );
                continue;
            }
            let property_id = property.PropertyIDs[0];
            match materials
                .get(&property.ResourceID)
                .and_then(|group| group.get(&property_id))
            {
                Some(material_label) => {
                    local_materials.insert(material_label.clone());
                }
                None => {
                    part.note(
                        SceneLoadStatus::Partial,
                        format!(
                            "resource {} property {} is not a supported base material",
                            property.ResourceID, property_id
                        ),
                    );
                }
            }
        }

        match local_materials.len() {
            0 => {}
            1 => {
                if let Some(material_label) = local_materials.into_iter().next() {
                    part.observe_material(material_label);
                }
            }
            _ => {
                part.note(
                    SceneLoadStatus::Partial,
                    format!(
                        "part uses multiple base materials: {}",
                        local_materials.into_iter().collect::<Vec<_>>().join(", ")
                    ),
                );
                if part.material_label.is_none() {
                    part.material_label = Some("Mixed materials".to_string());
                }
            }
        }
    }

    fn mesh_triangle_properties(
        &self,
        mesh: Lib3MF_MeshObject,
        triangle_count: u32,
    ) -> Result<Vec<sTriangleProperties>, ThreeMfError> {
        if triangle_count == 0 {
            return Ok(Vec::new());
        }

        let triangle_count_usize =
            usize::try_from(triangle_count).map_err(|_| ThreeMfError::TooLarge)?;
        let mut properties = vec![
            sTriangleProperties {
                ResourceID: 0,
                PropertyIDs: [0; 3],
            };
            triangle_count_usize
        ];
        let mut needed = 0u64;
        self.check(
            mesh as Lib3MF_Base,
            unsafe {
                (self.api().lib3mf_meshobject_getalltriangleproperties)(
                    mesh,
                    u64::from(triangle_count),
                    &mut needed,
                    properties.as_mut_ptr(),
                )
            },
            "MeshObject::GetAllTriangleProperties",
        )?;
        Ok(properties)
    }

    fn count_objects(&self, model: Lib3MF_Model) -> Result<usize, ThreeMfError> {
        let objects = self.get_objects(model)?;
        let mut count = 0usize;
        let mut has_next = 0;
        loop {
            self.check(
                objects.raw,
                unsafe {
                    (self.api().lib3mf_resourceiterator_movenext)(
                        objects.as_resource_iterator(),
                        &mut has_next,
                    )
                },
                "ObjectIterator::MoveNext",
            )?;
            if has_next == 0 {
                break;
            }
            count = count.checked_add(1).ok_or(ThreeMfError::TooLarge)?;
            let _current = self.current_object(objects.as_object_iterator())?;
        }
        Ok(count)
    }

    fn collect_base_materials(&self, model: Lib3MF_Model) -> Result<MaterialCatalog, ThreeMfError> {
        let iterator = self.get_base_material_groups(model)?;
        let mut catalog = MaterialCatalog::new();
        let mut has_next: CBool = 0;

        loop {
            self.check(
                iterator.raw,
                unsafe {
                    (self.api().lib3mf_resourceiterator_movenext)(
                        iterator.as_resource_iterator(),
                        &mut has_next,
                    )
                },
                "BaseMaterialGroupIterator::MoveNext",
            )?;
            if has_next == 0 {
                break;
            }

            let group =
                self.current_base_material_group(iterator.as_base_material_group_iterator())?;
            let mut resource_id = 0;
            self.check(
                group.raw,
                unsafe {
                    (self.api().lib3mf_resource_getresourceid)(
                        group.raw as lib3mf_ffi::Lib3MF_Resource,
                        &mut resource_id,
                    )
                },
                "Resource::GetResourceID",
            )?;

            let mut material_count = 0;
            self.check(
                group.raw,
                unsafe {
                    (self.api().lib3mf_basematerialgroup_getcount)(
                        group.as_base_material_group(),
                        &mut material_count,
                    )
                },
                "BaseMaterialGroup::GetCount",
            )?;

            let mut group_map = HashMap::new();
            for index in 1..=material_count {
                let name = self.read_string(
                    group.raw,
                    "BaseMaterialGroup::GetName",
                    |buffer_len, needed, buffer| unsafe {
                        (self.api().lib3mf_basematerialgroup_getname)(
                            group.as_base_material_group(),
                            index,
                            buffer_len,
                            needed,
                            buffer,
                        )
                    },
                )?;
                let mut color = sColor {
                    Red: 0,
                    Green: 0,
                    Blue: 0,
                    Alpha: 0,
                };
                self.check(
                    group.raw,
                    unsafe {
                        (self.api().lib3mf_basematerialgroup_getdisplaycolor)(
                            group.as_base_material_group(),
                            index,
                            &mut color,
                        )
                    },
                    "BaseMaterialGroup::GetDisplayColor",
                )?;
                group_map.insert(
                    index,
                    format!(
                        "{name} (#{:02X}{:02X}{:02X})",
                        color.Red, color.Green, color.Blue
                    ),
                );
            }
            catalog.insert(resource_id, group_map);
        }

        Ok(catalog)
    }

    fn read_string<F>(
        &self,
        instance: Lib3MF_Base,
        context: &str,
        mut call: F,
    ) -> Result<String, ThreeMfError>
    where
        F: FnMut(u32, *mut u32, *mut c_char) -> i32,
    {
        let mut needed = 0u32;
        self.check(instance, call(0, &mut needed, ptr::null_mut()), context)?;
        if needed == 0 {
            return Ok(String::new());
        }

        let mut buffer = vec![0u8; usize::try_from(needed).map_err(|_| ThreeMfError::TooLarge)?];
        self.check(
            instance,
            call(needed, &mut needed, buffer.as_mut_ptr() as *mut c_char),
            context,
        )?;
        let value = unsafe { CStr::from_ptr(buffer.as_ptr() as *const c_char) }
            .to_string_lossy()
            .into_owned();
        Ok(value)
    }

    fn check(&self, instance: Lib3MF_Base, err: i32, context: &str) -> Result<(), ThreeMfError> {
        if err == 0 {
            return Ok(());
        }
        let message = self.last_error(instance);
        if message.is_empty() {
            Err(ThreeMfError::Lib3Mf(format!(
                "{context} failed with lib3mf error code {err}"
            )))
        } else {
            Err(ThreeMfError::Lib3Mf(format!("{context} failed: {message}")))
        }
    }

    fn last_error(&self, instance: Lib3MF_Base) -> String {
        let mut needed = 0u32;
        let mut has_error = 0;
        let first = unsafe {
            (self.api().lib3mf_getlasterror)(
                instance,
                0,
                &mut needed,
                ptr::null_mut(),
                &mut has_error,
            )
        };
        if first != 0 || has_error == 0 || needed == 0 {
            return String::new();
        }

        let Some(buffer_len) = usize::try_from(needed).ok() else {
            return String::new();
        };
        let mut buffer = vec![0u8; buffer_len];
        let second = unsafe {
            (self.api().lib3mf_getlasterror)(
                instance,
                needed,
                &mut needed,
                buffer.as_mut_ptr() as *mut c_char,
                &mut has_error,
            )
        };
        if second != 0 || has_error == 0 {
            return String::new();
        }
        unsafe { CStr::from_ptr(buffer.as_ptr() as *const c_char) }
            .to_string_lossy()
            .into_owned()
    }

    fn create_model(&self) -> Result<OwnedHandle<'_>, ThreeMfError> {
        let mut model: Lib3MF_Model = ptr::null_mut();
        self.check(
            ptr::null_mut(),
            unsafe { (self.api().lib3mf_createmodel)(&mut model) },
            "CreateModel",
        )?;
        Ok(OwnedHandle::new(self.api(), model))
    }

    fn query_reader(&self, model: Lib3MF_Model) -> Result<OwnedHandle<'_>, ThreeMfError> {
        let extension = CString::new("3mf")
            .map_err(|_| ThreeMfError::Lib3Mf("reader extension contains NUL".to_string()))?;
        let mut reader: Lib3MF_Reader = ptr::null_mut();
        self.check(
            model as Lib3MF_Base,
            unsafe {
                (self.api().lib3mf_model_queryreader)(model, extension.as_ptr(), &mut reader)
            },
            "Model::QueryReader",
        )?;
        Ok(OwnedHandle::new(self.api(), reader))
    }

    fn get_build_items(&self, model: Lib3MF_Model) -> Result<OwnedHandle<'_>, ThreeMfError> {
        let mut iterator = ptr::null_mut();
        self.check(
            model as Lib3MF_Base,
            unsafe { (self.api().lib3mf_model_getbuilditems)(model, &mut iterator) },
            "Model::GetBuildItems",
        )?;
        Ok(OwnedHandle::new(self.api(), iterator))
    }

    fn get_objects(&self, model: Lib3MF_Model) -> Result<OwnedHandle<'_>, ThreeMfError> {
        let mut iterator = ptr::null_mut();
        self.check(
            model as Lib3MF_Base,
            unsafe { (self.api().lib3mf_model_getobjects)(model, &mut iterator) },
            "Model::GetObjects",
        )?;
        Ok(OwnedHandle::new(self.api(), iterator))
    }

    fn current_build_item(
        &self,
        iterator: lib3mf_ffi::Lib3MF_BuildItemIterator,
    ) -> Result<OwnedHandle<'_>, ThreeMfError> {
        let mut build_item: Lib3MF_BuildItem = ptr::null_mut();
        self.check(
            iterator as Lib3MF_Base,
            unsafe { (self.api().lib3mf_builditemiterator_getcurrent)(iterator, &mut build_item) },
            "BuildItemIterator::GetCurrent",
        )?;
        Ok(OwnedHandle::new(self.api(), build_item))
    }

    fn current_object(
        &self,
        iterator: lib3mf_ffi::Lib3MF_ObjectIterator,
    ) -> Result<OwnedHandle<'_>, ThreeMfError> {
        let mut object: Lib3MF_Object = ptr::null_mut();
        self.check(
            iterator as Lib3MF_Base,
            unsafe { (self.api().lib3mf_objectiterator_getcurrentobject)(iterator, &mut object) },
            "ObjectIterator::GetCurrentObject",
        )?;
        Ok(OwnedHandle::new(self.api(), object))
    }

    fn build_item_object(
        &self,
        build_item: Lib3MF_BuildItem,
    ) -> Result<OwnedHandle<'_>, ThreeMfError> {
        let mut object: Lib3MF_Object = ptr::null_mut();
        self.check(
            build_item as Lib3MF_Base,
            unsafe { (self.api().lib3mf_builditem_getobjectresource)(build_item, &mut object) },
            "BuildItem::GetObjectResource",
        )?;
        Ok(OwnedHandle::new(self.api(), object))
    }

    fn component_object(
        &self,
        component: lib3mf_ffi::Lib3MF_Component,
    ) -> Result<OwnedHandle<'_>, ThreeMfError> {
        let mut object: Lib3MF_Object = ptr::null_mut();
        self.check(
            component as Lib3MF_Base,
            unsafe { (self.api().lib3mf_component_getobjectresource)(component, &mut object) },
            "Component::GetObjectResource",
        )?;
        Ok(OwnedHandle::new(self.api(), object))
    }

    fn mesh_object(
        &self,
        model: Lib3MF_Model,
        resource_id: u32,
    ) -> Result<OwnedHandle<'_>, ThreeMfError> {
        let mut mesh: Lib3MF_MeshObject = ptr::null_mut();
        self.check(
            model as Lib3MF_Base,
            unsafe { (self.api().lib3mf_model_getmeshobjectbyid)(model, resource_id, &mut mesh) },
            "Model::GetMeshObjectByID",
        )?;
        Ok(OwnedHandle::new(self.api(), mesh))
    }

    fn components_object(
        &self,
        model: Lib3MF_Model,
        resource_id: u32,
    ) -> Result<OwnedHandle<'_>, ThreeMfError> {
        let mut object: Lib3MF_ComponentsObject = ptr::null_mut();
        self.check(
            model as Lib3MF_Base,
            unsafe {
                (self.api().lib3mf_model_getcomponentsobjectbyid)(model, resource_id, &mut object)
            },
            "Model::GetComponentsObjectByID",
        )?;
        Ok(OwnedHandle::new(self.api(), object))
    }

    fn component(
        &self,
        object: Lib3MF_ComponentsObject,
        index: u32,
    ) -> Result<OwnedHandle<'_>, ThreeMfError> {
        let mut component = ptr::null_mut();
        self.check(
            object as Lib3MF_Base,
            unsafe {
                (self.api().lib3mf_componentsobject_getcomponent)(object, index, &mut component)
            },
            "ComponentsObject::GetComponent",
        )?;
        Ok(OwnedHandle::new(self.api(), component))
    }

    fn get_base_material_groups(
        &self,
        model: Lib3MF_Model,
    ) -> Result<OwnedHandle<'_>, ThreeMfError> {
        let mut iterator = ptr::null_mut();
        self.check(
            model as Lib3MF_Base,
            unsafe { (self.api().lib3mf_model_getbasematerialgroups)(model, &mut iterator) },
            "Model::GetBaseMaterialGroups",
        )?;
        Ok(OwnedHandle::new(self.api(), iterator))
    }

    fn current_base_material_group(
        &self,
        iterator: lib3mf_ffi::Lib3MF_BaseMaterialGroupIterator,
    ) -> Result<OwnedHandle<'_>, ThreeMfError> {
        let mut group = ptr::null_mut();
        self.check(
            iterator as Lib3MF_Base,
            unsafe {
                (self
                    .api()
                    .lib3mf_basematerialgroupiterator_getcurrentbasematerialgroup)(
                    iterator, &mut group,
                )
            },
            "BaseMaterialGroupIterator::GetCurrentBaseMaterialGroup",
        )?;
        Ok(OwnedHandle::new(self.api(), group))
    }

    fn build_item_transform(
        &self,
        build_item: Lib3MF_BuildItem,
    ) -> Result<AffineTransform, ThreeMfError> {
        let mut has_transform = 0;
        self.check(
            build_item as Lib3MF_Base,
            unsafe {
                (self.api().lib3mf_builditem_hasobjecttransform)(build_item, &mut has_transform)
            },
            "BuildItem::HasObjectTransform",
        )?;
        if has_transform == 0 {
            return Ok(AffineTransform::identity());
        }

        let mut transform = sTransform {
            Fields: [[0.0; 4]; 3],
        };
        self.check(
            build_item as Lib3MF_Base,
            unsafe { (self.api().lib3mf_builditem_getobjecttransform)(build_item, &mut transform) },
            "BuildItem::GetObjectTransform",
        )?;
        Ok(AffineTransform::from_lib3mf(transform))
    }

    fn component_transform(
        &self,
        component: lib3mf_ffi::Lib3MF_Component,
    ) -> Result<AffineTransform, ThreeMfError> {
        let mut has_transform = 0;
        self.check(
            component as Lib3MF_Base,
            unsafe { (self.api().lib3mf_component_hastransform)(component, &mut has_transform) },
            "Component::HasTransform",
        )?;
        if has_transform == 0 {
            return Ok(AffineTransform::identity());
        }

        let mut transform = sTransform {
            Fields: [[0.0; 4]; 3],
        };
        self.check(
            component as Lib3MF_Base,
            unsafe { (self.api().lib3mf_component_gettransform)(component, &mut transform) },
            "Component::GetTransform",
        )?;
        Ok(AffineTransform::from_lib3mf(transform))
    }

    fn build_item_part_number(
        &self,
        build_item: Lib3MF_BuildItem,
    ) -> Result<Option<String>, ThreeMfError> {
        let value = self.read_string(
            build_item as Lib3MF_Base,
            "BuildItem::GetPartNumber",
            |buffer_len, needed, buffer| unsafe {
                (self.api().lib3mf_builditem_getpartnumber)(build_item, buffer_len, needed, buffer)
            },
        )?;
        Ok(if value.is_empty() { None } else { Some(value) })
    }

    fn object_display_name(
        &self,
        object: Lib3MF_Object,
        object_id: u32,
        build_part_number: Option<&str>,
    ) -> Result<String, ThreeMfError> {
        let name = self.read_string(
            object as Lib3MF_Base,
            "Object::GetName",
            |buffer_len, needed, buffer| unsafe {
                (self.api().lib3mf_object_getname)(object, buffer_len, needed, buffer)
            },
        )?;
        if !name.is_empty() {
            return Ok(name);
        }

        let part_number = self.read_string(
            object as Lib3MF_Base,
            "Object::GetPartNumber",
            |buffer_len, needed, buffer| unsafe {
                (self.api().lib3mf_object_getpartnumber)(object, buffer_len, needed, buffer)
            },
        )?;
        if !part_number.is_empty() {
            return Ok(part_number);
        }

        if let Some(part_number) = build_part_number {
            if !part_number.is_empty() {
                return Ok(part_number.to_string());
            }
        }

        Ok(format!("Object {object_id}"))
    }

    fn object_type(&self, object: Lib3MF_Object) -> Result<eObjectType, ThreeMfError> {
        let mut object_type = eObjectType::Other;
        self.check(
            object as Lib3MF_Base,
            unsafe { (self.api().lib3mf_object_gettype)(object, &mut object_type) },
            "Object::GetType",
        )?;
        Ok(object_type)
    }

    fn object_resource_id(&self, object: Lib3MF_Object) -> Result<u32, ThreeMfError> {
        let mut resource_id = 0;
        self.check(
            object as Lib3MF_Base,
            unsafe {
                (self.api().lib3mf_resource_getresourceid)(
                    object as lib3mf_ffi::Lib3MF_Resource,
                    &mut resource_id,
                )
            },
            "Resource::GetResourceID",
        )?;
        Ok(resource_id)
    }

    fn model_unit(&self, model: Lib3MF_Model) -> Result<String, ThreeMfError> {
        let mut unit = eModelUnit::MilliMeter;
        self.check(
            model as Lib3MF_Base,
            unsafe { (self.api().lib3mf_model_getunit)(model, &mut unit) },
            "Model::GetUnit",
        )?;
        Ok(match unit {
            eModelUnit::MicroMeter => "micrometer",
            eModelUnit::MilliMeter => "millimeter",
            eModelUnit::CentiMeter => "centimeter",
            eModelUnit::Inch => "inch",
            eModelUnit::Foot => "foot",
            eModelUnit::Meter => "meter",
        }
        .to_string())
    }
}

struct MeshOutput {
    vertices: Vec<[f32; 3]>,
    triangles: Vec<[u32; 3]>,
    bounds: Aabb,
    messages: BTreeSet<String>,
}

impl Default for MeshOutput {
    fn default() -> Self {
        Self {
            vertices: Vec::new(),
            triangles: Vec::new(),
            bounds: Aabb::empty(),
            messages: BTreeSet::new(),
        }
    }
}

#[derive(Clone, Copy)]
struct AffineTransform {
    rows: [[f32; 3]; 4],
}

impl AffineTransform {
    fn identity() -> Self {
        Self {
            rows: [
                [1.0, 0.0, 0.0],
                [0.0, 1.0, 0.0],
                [0.0, 0.0, 1.0],
                [0.0, 0.0, 0.0],
            ],
        }
    }

    fn from_lib3mf(transform: sTransform) -> Self {
        Self {
            rows: [
                [
                    transform.Fields[0][0],
                    transform.Fields[0][1],
                    transform.Fields[0][2],
                ],
                [
                    transform.Fields[1][0],
                    transform.Fields[1][1],
                    transform.Fields[1][2],
                ],
                [
                    transform.Fields[2][0],
                    transform.Fields[2][1],
                    transform.Fields[2][2],
                ],
                [
                    transform.Fields[0][3],
                    transform.Fields[1][3],
                    transform.Fields[2][3],
                ],
            ],
        }
    }

    fn apply(self, point: [f32; 3]) -> [f32; 3] {
        let [x, y, z] = point;
        [
            x * self.rows[0][0] + y * self.rows[0][1] + z * self.rows[0][2] + self.rows[3][0],
            x * self.rows[1][0] + y * self.rows[1][1] + z * self.rows[1][2] + self.rows[3][1],
            x * self.rows[2][0] + y * self.rows[2][1] + z * self.rows[2][2] + self.rows[3][2],
        ]
    }

    fn compose(self, then: &Self) -> Self {
        let mut rows = [[0.0f32; 3]; 4];
        for (i, row) in rows.iter_mut().enumerate().take(3) {
            for (k, cell) in row.iter_mut().enumerate() {
                *cell = self.rows[i][0] * then.rows[0][k]
                    + self.rows[i][1] * then.rows[1][k]
                    + self.rows[i][2] * then.rows[2][k];
            }
        }
        for (k, cell) in rows[3].iter_mut().enumerate() {
            *cell = self.rows[3][0] * then.rows[0][k]
                + self.rows[3][1] * then.rows[1][k]
                + self.rows[3][2] * then.rows[2][k]
                + then.rows[3][k];
        }
        Self { rows }
    }
}

struct PartAccumulator {
    name: String,
    triangle_start: usize,
    triangle_count: usize,
    status: SceneLoadStatus,
    part_number: Option<String>,
    material_label: Option<String>,
    messages: BTreeSet<String>,
}

impl PartAccumulator {
    fn new(name: String, triangle_start: usize, part_number: Option<String>) -> Self {
        Self {
            name,
            triangle_start,
            triangle_count: 0,
            status: SceneLoadStatus::Complete,
            part_number,
            material_label: None,
            messages: BTreeSet::new(),
        }
    }

    fn note(&mut self, status: SceneLoadStatus, message: String) {
        self.status = self.status.combine(status);
        self.messages.insert(message);
    }

    fn observe_material(&mut self, material_label: String) {
        match &self.material_label {
            Some(existing) if existing != &material_label => {
                self.note(
                    SceneLoadStatus::Partial,
                    format!("part uses multiple base materials: {existing}, {material_label}"),
                );
                self.material_label = Some("Mixed materials".to_string());
            }
            Some(_) => {}
            None => self.material_label = Some(material_label),
        }
    }

    fn finish(self) -> ThreeMfPart {
        ThreeMfPart {
            name: self.name,
            triangle_start: self.triangle_start,
            triangle_count: self.triangle_count,
            status: self.status,
            status_detail: (!self.messages.is_empty())
                .then(|| self.messages.into_iter().collect::<Vec<_>>().join("; ")),
            part_number: self.part_number,
            material_label: self.material_label,
        }
    }
}

struct OwnedHandle<'a> {
    api: &'a LoadedLib3mfApi,
    raw: Lib3MF_Base,
}

impl<'a> OwnedHandle<'a> {
    fn new(api: &'a LoadedLib3mfApi, raw: Lib3MF_Base) -> Self {
        Self { api, raw }
    }

    fn as_model(&self) -> Lib3MF_Model {
        self.raw as Lib3MF_Model
    }

    fn as_reader(&self) -> Lib3MF_Reader {
        self.raw as Lib3MF_Reader
    }

    fn as_object(&self) -> Lib3MF_Object {
        self.raw as Lib3MF_Object
    }

    fn as_mesh_object(&self) -> Lib3MF_MeshObject {
        self.raw as Lib3MF_MeshObject
    }

    fn as_components_object(&self) -> Lib3MF_ComponentsObject {
        self.raw as Lib3MF_ComponentsObject
    }

    fn as_build_item(&self) -> Lib3MF_BuildItem {
        self.raw as Lib3MF_BuildItem
    }

    fn as_build_item_iterator(&self) -> lib3mf_ffi::Lib3MF_BuildItemIterator {
        self.raw as lib3mf_ffi::Lib3MF_BuildItemIterator
    }

    fn as_object_iterator(&self) -> lib3mf_ffi::Lib3MF_ObjectIterator {
        self.raw as lib3mf_ffi::Lib3MF_ObjectIterator
    }

    fn as_resource_iterator(&self) -> lib3mf_ffi::Lib3MF_ResourceIterator {
        self.raw as lib3mf_ffi::Lib3MF_ResourceIterator
    }

    fn as_base_material_group_iterator(&self) -> lib3mf_ffi::Lib3MF_BaseMaterialGroupIterator {
        self.raw as lib3mf_ffi::Lib3MF_BaseMaterialGroupIterator
    }

    fn as_base_material_group(&self) -> lib3mf_ffi::Lib3MF_BaseMaterialGroup {
        self.raw as lib3mf_ffi::Lib3MF_BaseMaterialGroup
    }
}

impl Drop for OwnedHandle<'_> {
    fn drop(&mut self) {
        if !self.raw.is_null() {
            let _ = unsafe { (self.api.lib3mf_release)(self.raw) };
        }
    }
}

type MaterialCatalog = HashMap<u32, HashMap<u32, String>>;

#[derive(Clone, Copy)]
enum NativeValidationFailureKind {
    ValidatorUnavailable,
    ValidationFailed,
}

fn merge_or_fallback(
    mut mesh: ThreeMfMesh,
    validated: Result<ThreeMfMesh, ThreeMfError>,
    failure_kind: NativeValidationFailureKind,
    guard: &mut ParseGuard,
) -> Result<ThreeMfMesh, ThreeMfError> {
    match validated {
        Ok(validated) => {
            merge_validated_scene(&mut mesh, validated, guard)?;
            Ok(mesh)
        }
        Err(error) => {
            mesh.status = mesh.status.combine(SceneLoadStatus::Unsupported);
            let context = match failure_kind {
                NativeValidationFailureKind::ValidatorUnavailable => {
                    "native lib3mf validator unavailable, falling back to internal parser"
                }
                NativeValidationFailureKind::ValidationFailed => {
                    "native lib3mf validation failed, falling back to internal parser"
                }
            };
            let message = format!("{context}: {error}");
            if !mesh
                .status_messages
                .iter()
                .any(|existing| existing == &message)
            {
                mesh.status_messages.push(message);
            }
            guard.check_now()?;
            Ok(mesh)
        }
    }
}

fn merge_validated_scene(
    mesh: &mut ThreeMfMesh,
    validated: ThreeMfMesh,
    guard: &mut ParseGuard,
) -> Result<(), ThreeMfError> {
    guard.check_now()?;
    mesh.unit = validated.unit;
    mesh.object_count = validated.object_count;
    mesh.build_item_count = validated.build_item_count;
    // Combined rather than replaced. `mesh` arrives from the internal parser and
    // already carries its own findings - notably the appearance-corruption
    // diagnostics, which lib3mf does not report because it does not resolve
    // appearances the way the scene DTO needs. Assigning here discarded them, so
    // the identical corrupt file reported a degraded scene with the feature off
    // and a clean one with it on. A diagnostic that disappears when a validator
    // is enabled is worse than no diagnostic: it makes the stronger
    // configuration the quieter one.
    mesh.status = mesh.status.combine(validated.status);
    let mut seen_messages: HashSet<String> = mesh.status_messages.iter().cloned().collect();
    for message in validated.status_messages {
        guard.checkpoint()?;
        if seen_messages.insert(message.clone()) {
            mesh.status_messages.push(message);
        }
    }

    for (part, validated_part) in mesh.parts.iter_mut().zip(validated.parts) {
        guard.checkpoint()?;
        if !validated_part.name.is_empty() {
            part.name = validated_part.name;
        }
        part.status = validated_part.status;
        part.status_detail = validated_part.status_detail;
        part.part_number = validated_part.part_number;
        part.material_label = validated_part.material_label;
    }

    if mesh.parts.len() != mesh.build_item_count {
        mesh.status = mesh.status.combine(SceneLoadStatus::Partial);
        mesh.status_messages.push(format!(
            "lib3mf reported {} build items but the normalized scene contains {} parts",
            mesh.build_item_count,
            mesh.parts.len()
        ));
    }
    guard.check_now()?;
    Ok(())
}

fn lib3mf_library_bases() -> Result<Vec<PathBuf>, ThreeMfError> {
    let exe_path = std::env::current_exe().map_err(|error| {
        ThreeMfError::Lib3Mf(format!(
            "failed to determine current executable for lib3mf search: {error}"
        ))
    })?;
    let exe_dir = canonical_exe_dir(&exe_path)?;
    Ok(lib3mf_library_bases_from_exe_dir(&exe_dir))
}

fn canonical_exe_dir(exe_path: &Path) -> Result<PathBuf, ThreeMfError> {
    let canonical_exe = exe_path.canonicalize().map_err(|error| {
        ThreeMfError::Lib3Mf(format!(
            "failed to canonicalize current executable for lib3mf search: {error}"
        ))
    })?;
    canonical_exe
        .parent()
        .map(Path::to_path_buf)
        .ok_or_else(|| {
            ThreeMfError::Lib3Mf(format!(
                "canonical executable path {:?} has no parent directory",
                canonical_exe
            ))
        })
}

fn lib3mf_library_bases_from_exe_dir(exe_dir: &Path) -> Vec<PathBuf> {
    let mut bases = Vec::new();
    push_library_base(&mut bases, exe_dir.join("lib3mf"));
    push_library_base(&mut bases, exe_dir.join("libraries").join("lib3mf"));
    bases
}

fn load_wrapper_from_library_bases<T, F>(bases: &[PathBuf], mut load: F) -> Result<T, ThreeMfError>
where
    F: FnMut(&Path) -> Result<T, String>,
{
    let mut attempts = Vec::new();
    for candidate in bases {
        if !candidate.is_absolute() {
            return Err(ThreeMfError::Lib3Mf(format!(
                "lib3mf search path must be absolute: {:?}",
                candidate
            )));
        }

        match load(candidate) {
            Ok(wrapper) => return Ok(wrapper),
            Err(error) => attempts.push(format!("{}: {error}", candidate.display())),
        }
    }

    let attempted_paths = if attempts.is_empty() {
        "no curated absolute lib3mf search paths were available".to_string()
    } else {
        attempts.join(" | ")
    };

    Err(ThreeMfError::Lib3Mf(format!(
        "failed to locate lib3mf shared library via curated absolute paths; tried {attempted_paths}"
    )))
}

fn push_library_base(bases: &mut Vec<PathBuf>, base: PathBuf) {
    if !bases.iter().any(|candidate| candidate == &base) {
        bases.push(base);
    }
}

fn lib3mf_library_extension() -> &'static str {
    if cfg!(windows) {
        "dll"
    } else if cfg!(target_os = "macos") {
        "dylib"
    } else {
        "so"
    }
}

fn lib3mf_library_path(base: &Path) -> PathBuf {
    let mut path = base.to_path_buf();
    path.set_extension(lib3mf_library_extension());
    path
}

fn load_wrapper_from_library_base(base: &Path) -> Result<LoadedLib3mf, String> {
    let library_path = lib3mf_library_path(base);
    if !library_path.is_absolute() {
        return Err(format!(
            "lib3mf shared library path must be absolute: {}",
            library_path.display()
        ));
    }
    with_verified_staged_library_load_path(
        &library_path,
        expected_staged_test_library_hash(&library_path).as_deref(),
        |_load_path, load_path_str| {
            #[cfg(windows)]
            {
                let library_dir = library_path.parent().ok_or_else(|| {
                    format!(
                        "lib3mf shared library path has no parent directory: {}",
                        library_path.display()
                    )
                })?;
                ensure_hardened_windows_dll_search()?;
                with_windows_added_dll_directory(
                    library_dir,
                    add_windows_dll_directory,
                    remove_windows_dll_directory,
                    || LoadedLib3mf::new(load_path_str),
                )
            }
            #[cfg(not(windows))]
            {
                LoadedLib3mf::new(load_path_str)
            }
        },
    )
}

#[cfg(windows)]
const LOAD_LIBRARY_SEARCH_APPLICATION_DIR: u32 = 0x0000_0200;
#[cfg(windows)]
const LOAD_LIBRARY_SEARCH_USER_DIRS: u32 = 0x0000_0400;
#[cfg(windows)]
const LOAD_LIBRARY_SEARCH_SYSTEM32: u32 = 0x0000_0800;

#[cfg(windows)]
type DllDirectoryCookie = *mut std::ffi::c_void;

#[cfg(windows)]
#[link(name = "kernel32")]
extern "system" {
    fn AddDllDirectory(new_directory: *const u16) -> DllDirectoryCookie;
    fn GetLastError() -> u32;
    fn RemoveDllDirectory(cookie: DllDirectoryCookie) -> i32;
    fn SetDefaultDllDirectories(directory_flags: u32) -> i32;
}

#[cfg(windows)]
fn hardened_windows_dll_search_flags() -> u32 {
    LOAD_LIBRARY_SEARCH_APPLICATION_DIR
        | LOAD_LIBRARY_SEARCH_SYSTEM32
        | LOAD_LIBRARY_SEARCH_USER_DIRS
}

#[cfg(windows)]
fn ensure_hardened_windows_dll_search() -> Result<(), String> {
    static INITIALIZED: OnceLock<Result<(), String>> = OnceLock::new();
    INITIALIZED
        .get_or_init(|| {
            let success = unsafe { SetDefaultDllDirectories(hardened_windows_dll_search_flags()) };
            if success == 0 {
                Err(format!(
                    "SetDefaultDllDirectories failed with Win32 error {}",
                    unsafe { GetLastError() }
                ))
            } else {
                Ok(())
            }
        })
        .clone()
}

#[cfg(windows)]
fn add_windows_dll_directory(directory: &Path) -> Result<DllDirectoryCookie, String> {
    use std::os::windows::ffi::OsStrExt;

    let mut wide = directory.as_os_str().encode_wide().collect::<Vec<_>>();
    wide.push(0);
    let cookie = unsafe { AddDllDirectory(wide.as_ptr()) };
    if cookie.is_null() {
        Err(format!(
            "AddDllDirectory failed for {} with Win32 error {}",
            directory.display(),
            unsafe { GetLastError() }
        ))
    } else {
        Ok(cookie)
    }
}

#[cfg(windows)]
fn remove_windows_dll_directory(cookie: DllDirectoryCookie) -> Result<(), String> {
    let success = unsafe { RemoveDllDirectory(cookie) };
    if success == 0 {
        Err(format!(
            "RemoveDllDirectory failed with Win32 error {}",
            unsafe { GetLastError() }
        ))
    } else {
        Ok(())
    }
}

#[cfg(windows)]
fn with_windows_added_dll_directory<T, AddDir, RemoveDir, Load>(
    directory: &Path,
    mut add_directory: AddDir,
    mut remove_directory: RemoveDir,
    load: Load,
) -> Result<T, String>
where
    AddDir: FnMut(&Path) -> Result<DllDirectoryCookie, String>,
    RemoveDir: FnMut(DllDirectoryCookie) -> Result<(), String>,
    Load: FnOnce() -> Result<T, String>,
{
    let cookie = add_directory(directory)?;
    let load_result = load();
    let remove_result = remove_directory(cookie);

    match (load_result, remove_result) {
        (Ok(value), Ok(())) => Ok(value),
        (Err(error), Ok(())) => Err(error),
        (Ok(_), Err(error)) => Err(error),
        (Err(load_error), Err(remove_error)) => Err(format!(
            "{load_error}; additionally failed to remove hardened DLL directory: {remove_error}"
        )),
    }
}

const MODEL_CORE_CARGO_TOML: &str = include_str!("../Cargo.toml");
const LIB3MF_PIN_LOCK: &str = include_str!("../lib3mf-pin.lock");
const LIB3MF_STAGE_BUFFER_SIZE: usize = 64 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
struct PinnedLib3mfArtifact {
    revision: String,
    extension: String,
    sha256: String,
}

fn pinned_lib3mf_revision() -> &'static str {
    extract_pinned_lib3mf_revision(MODEL_CORE_CARGO_TOML)
        .expect("native/model-core/Cargo.toml must pin lib3mf-ffi to an exact rev")
}

fn pinned_lib3mf_artifact(extension: &str) -> Result<PinnedLib3mfArtifact, String> {
    let manifest_revision = pinned_lib3mf_revision();
    let lock = parse_pinned_lib3mf_lock(LIB3MF_PIN_LOCK)?;
    if lock.revision != manifest_revision {
        return Err(format!(
            "native/model-core/lib3mf-pin.lock pins revision {} but Cargo.toml pins {}; update both together",
            lock.revision, manifest_revision
        ));
    }

    let sha256 = lock.hashes.get(extension).ok_or_else(|| {
        format!(
            "native/model-core/lib3mf-pin.lock does not record a vetted SHA-256 for lib3mf.{extension}"
        )
    })?;

    Ok(PinnedLib3mfArtifact {
        revision: lock.revision.to_string(),
        extension: extension.to_string(),
        sha256: sha256.clone(),
    })
}

fn extract_pinned_lib3mf_revision(manifest: &str) -> Result<&str, String> {
    manifest
        .lines()
        .find(|line| line.trim_start().starts_with("lib3mf-ffi = "))
        .and_then(|line| line.split("rev = \"").nth(1))
        .and_then(|rev| rev.split('"').next())
        .filter(|rev| !rev.is_empty())
        .ok_or_else(|| {
            "unable to extract lib3mf-ffi rev from native/model-core/Cargo.toml".to_string()
        })
}

struct PinnedLib3mfLock {
    revision: String,
    hashes: HashMap<String, String>,
}

fn parse_pinned_lib3mf_lock(lockfile: &str) -> Result<PinnedLib3mfLock, String> {
    let mut revision = None;
    let mut hashes = HashMap::new();

    for (line_index, line) in lockfile.lines().enumerate() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }

        let (key, raw_value) = trimmed.split_once('=').ok_or_else(|| {
            format!(
                "invalid native/model-core/lib3mf-pin.lock line {}: expected key = \"value\"",
                line_index + 1
            )
        })?;
        let key = key.trim();
        let value = parse_lockfile_value(raw_value.trim(), line_index + 1)?;

        match key {
            "revision" => {
                if !is_git_revision(value) {
                    return Err(format!(
                        "invalid lib3mf pin revision on line {}: expected 40 lowercase hex characters",
                        line_index + 1
                    ));
                }
                revision = Some(value.to_string());
            }
            "dll" | "dylib" | "so" => {
                if !is_sha256(value) {
                    return Err(format!(
                        "invalid lib3mf SHA-256 for {key} on line {}: expected 64 lowercase hex characters",
                        line_index + 1
                    ));
                }
                hashes.insert(key.to_string(), value.to_string());
            }
            other => {
                return Err(format!(
                    "unsupported native/model-core/lib3mf-pin.lock key `{other}` on line {}",
                    line_index + 1
                ));
            }
        }
    }

    let revision = revision.ok_or_else(|| {
        "native/model-core/lib3mf-pin.lock must declare revision = \"<git sha>\"".to_string()
    })?;
    for extension in ["dll", "dylib", "so"] {
        if !hashes.contains_key(extension) {
            return Err(format!(
                "native/model-core/lib3mf-pin.lock must declare a vetted SHA-256 for lib3mf.{extension}"
            ));
        }
    }

    Ok(PinnedLib3mfLock { revision, hashes })
}

fn parse_lockfile_value<'a>(value: &'a str, line_number: usize) -> Result<&'a str, String> {
    value
        .strip_prefix('"')
        .and_then(|inner| inner.strip_suffix('"'))
        .ok_or_else(|| {
            format!(
                "invalid native/model-core/lib3mf-pin.lock line {}: values must be quoted",
                line_number
            )
        })
}

fn is_git_revision(value: &str) -> bool {
    value.len() == 40
        && value
            .bytes()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
}

fn is_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
}

pub(crate) fn stage_test_library_for_current_exe() -> Result<(), String> {
    static STAGED: OnceLock<Result<(), String>> = OnceLock::new();
    STAGED
        .get_or_init(stage_test_library_for_current_exe_once)
        .clone()
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct StagedLib3mfExpectation {
    library_path: PathBuf,
    sha256: String,
}

fn staged_test_library_expectation() -> &'static OnceLock<StagedLib3mfExpectation> {
    static EXPECTATION: OnceLock<StagedLib3mfExpectation> = OnceLock::new();
    &EXPECTATION
}

fn register_staged_test_library(path: PathBuf, sha256: String) -> Result<(), String> {
    if let Some(existing) = staged_test_library_expectation().get() {
        return if existing.library_path == path && existing.sha256 == sha256 {
            Ok(())
        } else {
            Err(format!(
                "staged lib3mf expectation already recorded for {} with SHA-256 {}",
                existing.library_path.display(),
                existing.sha256
            ))
        };
    }

    staged_test_library_expectation()
        .set(StagedLib3mfExpectation {
            library_path: path,
            sha256,
        })
        .map_err(|_| "failed to record staged lib3mf expectation".to_string())
}

fn expected_staged_test_library_hash(library_path: &Path) -> Option<String> {
    staged_test_library_expectation()
        .get()
        .filter(|expected| expected.library_path == library_path)
        .map(|expected| expected.sha256.clone())
}

fn stage_test_library_for_current_exe_once() -> Result<(), String> {
    let extension = lib3mf_library_extension();
    let artifact = pinned_lib3mf_artifact(extension)?;
    let exe_dir = std::env::current_exe()
        .map_err(|error| format!("unable to locate test executable: {error}"))?
        .parent()
        .map(Path::to_path_buf)
        .ok_or_else(|| "test executable has no parent directory".to_string())?;
    let staged = exe_dir.join(format!("lib3mf.{extension}"));

    let cargo_home = std::env::var_os("CARGO_HOME")
        .map(PathBuf::from)
        .or_else(|| {
            std::env::var_os("USERPROFILE").map(|profile| PathBuf::from(profile).join(".cargo"))
        })
        .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".cargo")))
        .ok_or_else(|| "unable to determine Cargo home for lib3mf test staging".to_string())?;
    let checkouts = cargo_home.join("git").join("checkouts");
    let staged_hash =
        stage_vetted_lib3mf_library(&checkouts, &staged, &artifact, verify_checkout_revision)?;
    register_staged_test_library(staged, staged_hash)
}

fn stage_vetted_lib3mf_library<F>(
    checkouts: &Path,
    staged: &Path,
    artifact: &PinnedLib3mfArtifact,
    verify_revision: F,
) -> Result<String, String>
where
    F: FnMut(&Path) -> Result<String, String>,
{
    stage_vetted_lib3mf_library_with_hook(checkouts, staged, artifact, verify_revision, |_| Ok(()))
}

fn stage_vetted_lib3mf_library_with_hook<F, H>(
    checkouts: &Path,
    staged: &Path,
    artifact: &PinnedLib3mfArtifact,
    mut verify_revision: F,
    mut before_stage: H,
) -> Result<String, String>
where
    F: FnMut(&Path) -> Result<String, String>,
    H: FnMut(&Path) -> Result<(), String>,
{
    let mut mismatches = Vec::new();
    let mut repo_entries = std::fs::read_dir(checkouts)
        .map_err(|error| format!("unable to read {checkouts:?}: {error}"))?
        .filter_map(Result::ok)
        .collect::<Vec<_>>();
    repo_entries.sort_by_key(|entry| entry.file_name());

    for entry in repo_entries {
        let name = entry.file_name().to_string_lossy().to_ascii_lowercase();
        if !name.starts_with("lib3mf_rs-") {
            continue;
        }

        let mut revision_entries = std::fs::read_dir(entry.path())
            .map_err(|error| format!("unable to inspect {:?}: {error}", entry.path()))?
            .filter_map(Result::ok)
            .collect::<Vec<_>>();
        revision_entries.sort_by_key(|revision| revision.file_name());

        for revision in revision_entries {
            let revision_path = revision.path();
            let candidate = revision_path
                .join("libraries")
                .join(format!("lib3mf.{}", artifact.extension));
            if !candidate.is_file() {
                continue;
            }

            let actual_revision = verify_revision(&revision_path)?;
            if actual_revision != artifact.revision {
                mismatches.push(format!(
                    "{} resolved to {actual_revision} (expected {})",
                    revision_path.display(),
                    artifact.revision
                ));
                continue;
            }

            // Open the cached checkout once, then hash and stage through that same
            // handle so later path swaps cannot change the bytes we copy.
            let mut source = open_library_source_for_staging(&candidate).map_err(|error| {
                format!(
                    "unable to open vetted lib3mf candidate {} with a stable read handle: {error}",
                    candidate.display()
                )
            })?;
            before_stage(&candidate)?;
            let actual_hash = match hash_and_stage_open_library(&candidate, &mut source, staged) {
                Ok(hash) => hash,
                Err(error) => {
                    let _ = std::fs::remove_file(staged);
                    return Err(error);
                }
            };
            if actual_hash != artifact.sha256 {
                let _ = std::fs::remove_file(staged);
                mismatches.push(format!(
                    "{} resolved to {} but {} content hash {} did not match vetted SHA-256 {}",
                    revision_path.display(),
                    actual_revision,
                    candidate.display(),
                    actual_hash,
                    artifact.sha256
                ));
                continue;
            }
            if let Err(error) = verify_staged_library_contents(staged, &actual_hash) {
                let _ = std::fs::remove_file(staged);
                return Err(error);
            }

            return Ok(actual_hash);
        }
    }

    if mismatches.is_empty() {
        Err(format!(
            "unable to find lib3mf.{} for pinned revision {} under {:?}",
            artifact.extension, artifact.revision, checkouts
        ))
    } else {
        Err(format!(
            "refusing to stage lib3mf.{} from cached checkouts because none matched pinned revision {} with vetted SHA-256 {}: {}",
            artifact.extension,
            artifact.revision,
            artifact.sha256,
            mismatches.join(" | ")
        ))
    }
}

fn hash_and_stage_open_library(
    source_path: &Path,
    source: &mut File,
    staged: &Path,
) -> Result<String, String> {
    if let Some(parent) = staged.parent() {
        std::fs::create_dir_all(parent).map_err(|error| {
            format!(
                "unable to create staged lib3mf directory {}: {error}",
                parent.display()
            )
        })?;
    }

    let mut staged_file = OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .open(staged)
        .map_err(|error| {
            format!(
                "unable to open staged lib3mf path {} for writing vetted bytes from {}: {error}",
                staged.display(),
                source_path.display()
            )
        })?;

    let mut hasher = sha2::Sha256::new();
    let mut buffer = [0u8; LIB3MF_STAGE_BUFFER_SIZE];
    loop {
        let read = source.read(&mut buffer).map_err(|error| {
            format!(
                "unable to read vetted lib3mf bytes from {} while staging {}: {error}",
                source_path.display(),
                staged.display()
            )
        })?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
        staged_file.write_all(&buffer[..read]).map_err(|error| {
            format!(
                "unable to write vetted lib3mf bytes from {} into staged path {}: {error}",
                source_path.display(),
                staged.display()
            )
        })?;
    }
    staged_file.flush().map_err(|error| {
        format!(
            "unable to flush staged lib3mf path {} after copying vetted bytes from {}: {error}",
            staged.display(),
            source_path.display()
        )
    })?;
    staged_file.sync_all().map_err(|error| {
        format!(
            "unable to sync staged lib3mf path {} after copying vetted bytes from {}: {error}",
            staged.display(),
            source_path.display()
        )
    })?;

    Ok(format!("{:x}", hasher.finalize()))
}

fn verify_staged_library_contents(staged: &Path, expected_hash: &str) -> Result<(), String> {
    let actual_hash = crate::hash::hash_file(staged).map_err(|error| {
        format!(
            "unable to hash staged lib3mf path {} after copying vetted bytes: {error}",
            staged.display()
        )
    })?;
    if actual_hash == expected_hash {
        Ok(())
    } else {
        Err(format!(
            "staged lib3mf path {} hash {} did not match the vetted bytes hash {}",
            staged.display(),
            actual_hash,
            expected_hash
        ))
    }
}

fn verify_staged_library_before_load(
    library_path: &Path,
    expected_hash: &str,
) -> Result<VerifiedStagedLibraryLoadGuard, String> {
    let mut file = open_staged_library_for_load_verification(library_path).map_err(|error| {
        format!(
            "unable to open staged lib3mf library {} for immediate pre-load verification: {error}",
            library_path.display()
        )
    })?;
    let actual_hash = crate::hash::hash_reader(&mut file).map_err(|error| {
        format!(
            "unable to hash staged lib3mf library {} immediately before load: {error}",
            library_path.display()
        )
    })?;
    if actual_hash == expected_hash {
        VerifiedStagedLibraryLoadGuard::new(file)
    } else {
        Err(format!(
            "staged lib3mf library {} hash {} did not match expected vetted SHA-256 {} immediately before load",
            library_path.display(),
            actual_hash,
            expected_hash
        ))
    }
}

fn with_verified_staged_library_load_path<T, F>(
    library_path: &Path,
    expected_hash: Option<&str>,
    load: F,
) -> Result<T, String>
where
    F: FnOnce(&Path, &str) -> Result<T, String>,
{
    // Keep the final pre-load verification bound to the actual load path. Windows
    // holds the staged file open without FILE_SHARE_WRITE/DELETE. Unix targets
    // pass /proc/self/fd/<fd> (Linux) or /dev/fd/<fd> (macOS/BSD) directly to
    // dlopen/libloading while keeping the verified descriptor open, so the load
    // never reopens the staged pathname or any helper filesystem object.
    let verified_staged_library = expected_hash
        .map(|expected_hash| verify_staged_library_before_load(library_path, expected_hash))
        .transpose()?;
    let load_path = verified_staged_library
        .as_ref()
        .map_or(library_path, |guard| guard.load_path(library_path));
    let load_path_str = load_path.to_str().ok_or_else(|| {
        format!(
            "lib3mf search path is not valid UTF-8: {}",
            load_path.display()
        )
    })?;
    load(load_path, load_path_str)
}

struct VerifiedStagedLibraryLoadGuard {
    _file: File,
    #[cfg(not(windows))]
    load_path: PathBuf,
}

impl VerifiedStagedLibraryLoadGuard {
    fn new(file: File) -> Result<Self, String> {
        #[cfg(windows)]
        {
            Ok(Self { _file: file })
        }

        #[cfg(not(windows))]
        {
            Ok(Self {
                load_path: verified_library_fd_path(&file)?,
                _file: file,
            })
        }
    }

    fn load_path<'a>(&'a self, default_path: &'a Path) -> &'a Path {
        #[cfg(windows)]
        {
            let _ = self;
            default_path
        }

        #[cfg(not(windows))]
        {
            &self.load_path
        }
    }
}

#[cfg(not(windows))]
fn verified_library_fd_path(file: &File) -> Result<PathBuf, String> {
    use std::os::fd::AsRawFd;

    #[cfg(target_os = "linux")]
    {
        return Ok(PathBuf::from(format!("/proc/self/fd/{}", file.as_raw_fd())));
    }

    #[cfg(any(
        target_os = "macos",
        target_os = "freebsd",
        target_os = "dragonfly",
        target_os = "netbsd",
        target_os = "openbsd"
    ))]
    {
        return Ok(PathBuf::from(format!("/dev/fd/{}", file.as_raw_fd())));
    }

    #[cfg(not(any(
        target_os = "linux",
        target_os = "macos",
        target_os = "freebsd",
        target_os = "dragonfly",
        target_os = "netbsd",
        target_os = "openbsd"
    )))]
    {
        Err("verified lib3mf fd-path loading is unsupported on this Unix platform".to_string())
    }
}

#[cfg(unix)]
fn create_file_symlink(target: &Path, link: &Path) -> std::io::Result<()> {
    std::os::unix::fs::symlink(target, link)
}

#[cfg(not(any(windows, unix)))]
fn create_file_symlink(_target: &Path, _link: &Path) -> std::io::Result<()> {
    Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "file symlinks are not supported on this platform",
    ))
}

fn open_library_source_for_staging(path: &Path) -> std::io::Result<File> {
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;

        const FILE_SHARE_READ: u32 = 0x0000_0001;
        const FILE_SHARE_DELETE: u32 = 0x0000_0004;

        OpenOptions::new()
            .read(true)
            .share_mode(FILE_SHARE_READ | FILE_SHARE_DELETE)
            .open(path)
    }

    #[cfg(not(windows))]
    {
        File::open(path)
    }
}

fn open_staged_library_for_load_verification(path: &Path) -> std::io::Result<File> {
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;

        const FILE_SHARE_READ: u32 = 0x0000_0001;

        OpenOptions::new()
            .read(true)
            .share_mode(FILE_SHARE_READ)
            .open(path)
    }

    #[cfg(not(windows))]
    {
        File::open(path)
    }
}

#[cfg(test)]
fn select_pinned_lib3mf_library<F>(
    checkouts: &Path,
    extension: &str,
    mut verify_revision: F,
) -> Result<PathBuf, String>
where
    F: FnMut(&Path) -> Result<String, String>,
{
    let artifact = pinned_lib3mf_artifact(extension)?;
    select_vetted_lib3mf_library(checkouts, &artifact, |revision_path| {
        verify_revision(revision_path)
    })
}

#[cfg(test)]
fn select_vetted_lib3mf_library<F>(
    checkouts: &Path,
    artifact: &PinnedLib3mfArtifact,
    mut verify_revision: F,
) -> Result<PathBuf, String>
where
    F: FnMut(&Path) -> Result<String, String>,
{
    let mut mismatches = Vec::new();
    let mut repo_entries = std::fs::read_dir(checkouts)
        .map_err(|error| format!("unable to read {checkouts:?}: {error}"))?
        .filter_map(Result::ok)
        .collect::<Vec<_>>();
    repo_entries.sort_by_key(|entry| entry.file_name());

    for entry in repo_entries {
        let name = entry.file_name().to_string_lossy().to_ascii_lowercase();
        if !name.starts_with("lib3mf_rs-") {
            continue;
        }

        let mut revision_entries = std::fs::read_dir(entry.path())
            .map_err(|error| format!("unable to inspect {:?}: {error}", entry.path()))?
            .filter_map(Result::ok)
            .collect::<Vec<_>>();
        revision_entries.sort_by_key(|revision| revision.file_name());

        for revision in revision_entries {
            let revision_path = revision.path();
            let candidate = revision_path
                .join("libraries")
                .join(format!("lib3mf.{}", artifact.extension));
            if !candidate.is_file() {
                continue;
            }

            let actual_revision = verify_revision(&revision_path)?;
            if actual_revision != artifact.revision {
                mismatches.push(format!(
                    "{} resolved to {actual_revision} (expected {})",
                    revision_path.display(),
                    artifact.revision
                ));
                continue;
            }

            let actual_hash = crate::hash::hash_file(&candidate).map_err(|error| {
                format!(
                    "unable to hash staged lib3mf candidate {}: {error}",
                    candidate.display()
                )
            })?;
            if actual_hash != artifact.sha256 {
                mismatches.push(format!(
                    "{} resolved to {} but {} content hash {} did not match vetted SHA-256 {}",
                    revision_path.display(),
                    actual_revision,
                    candidate.display(),
                    actual_hash,
                    artifact.sha256
                ));
                continue;
            }

            return Ok(candidate);
        }
    }

    if mismatches.is_empty() {
        Err(format!(
            "unable to find lib3mf.{} for pinned revision {} under {:?}",
            artifact.extension, artifact.revision, checkouts
        ))
    } else {
        Err(format!(
            "refusing to stage lib3mf.{} from cached checkouts because none matched pinned revision {} with vetted SHA-256 {}: {}",
            artifact.extension,
            artifact.revision,
            artifact.sha256,
            mismatches.join(" | ")
        ))
    }
}

fn verify_checkout_revision(revision_path: &Path) -> Result<String, String> {
    let revision = run_git_stdout(revision_path, &["rev-parse", "HEAD"], "git rev-parse HEAD")?;
    if revision.is_empty() {
        return Err(format!(
            "git rev-parse HEAD returned an empty revision for {}",
            revision_path.display()
        ));
    }

    let dirty_entries = run_git_stdout(
        revision_path,
        &["status", "--porcelain", "--untracked-files=no"],
        "git status --porcelain --untracked-files=no",
    )?;
    let dirty_entries = dirty_entries
        .lines()
        .map(str::trim_end)
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>();
    if !dirty_entries.is_empty() {
        return Err(format!(
            "lib3mf checkout at {} resolved to revision {} but has tracked working tree changes: {}",
            revision_path.display(),
            revision,
            dirty_entries.join(", ")
        ));
    }

    Ok(revision)
}

fn run_git_stdout(
    revision_path: &Path,
    args: &[&str],
    description: &str,
) -> Result<String, String> {
    let output = Command::new("git")
        .arg("-C")
        .arg(revision_path)
        .args(args)
        .output()
        .map_err(|error| {
            format!(
                "unable to verify lib3mf checkout at {} with `{description}`: {error}",
                revision_path.display()
            )
        })?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(format!(
            "{description} failed for {}: {}",
            revision_path.display(),
            if stderr.is_empty() {
                format!("exit status {}", output.status)
            } else {
                stderr
            }
        ));
    }

    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::limits::{LimitViolation, ParseLimits};
    use std::time::{Duration, Instant};

    fn test_guard() -> ParseGuard {
        ParseGuard::new(ParseLimits::default().without_timeout())
    }

    #[test]
    fn affine_transform_converts_lib3mf_matrix() {
        let transform = AffineTransform::from_lib3mf(sTransform {
            Fields: [
                [1.0, 0.0, 0.0, 5.0],
                [0.0, 1.0, 0.0, 7.0],
                [0.0, 0.0, 1.0, 9.0],
            ],
        });
        assert_eq!(transform.apply([1.0, 2.0, 3.0]), [6.0, 9.0, 12.0]);
    }

    #[test]
    fn fallback_marks_mesh_unsupported_when_validator_is_unavailable() {
        let mesh = sample_mesh();
        let mut guard = test_guard();

        let mesh = merge_or_fallback(
            mesh,
            Err(ThreeMfError::Lib3Mf(
                "failed to locate lib3mf shared library".to_string(),
            )),
            NativeValidationFailureKind::ValidatorUnavailable,
            &mut guard,
        )
        .unwrap();

        assert_eq!(mesh.status, SceneLoadStatus::Unsupported);
        assert_eq!(mesh.parts[0].status, SceneLoadStatus::Complete);
        assert!(mesh.status_messages.iter().any(|message| {
            message.contains("native lib3mf validator unavailable")
                && message.contains("failed to locate lib3mf shared library")
        }));
    }

    #[test]
    fn fallback_marks_mesh_unsupported_when_validation_fails() {
        let mesh = sample_mesh();
        let mut guard = test_guard();

        let mesh = merge_or_fallback(
            mesh,
            Err(ThreeMfError::Lib3Mf(
                "ReadFromBuffer failed: invalid resource reference".to_string(),
            )),
            NativeValidationFailureKind::ValidationFailed,
            &mut guard,
        )
        .unwrap();

        assert_eq!(mesh.status, SceneLoadStatus::Unsupported);
        assert!(mesh.status_messages.iter().any(|message| {
            message.contains("native lib3mf validation failed")
                && message.contains("invalid resource reference")
        }));
    }

    #[test]
    fn strict_native_parser_returns_lib3mf_error_for_invalid_namespace_fixture() {
        stage_test_library_for_current_exe().unwrap();

        let session = Lib3mfSession::new().unwrap();
        let path = fixture_path("lib3mf_invalid_namespace.3mf");
        let error = session.parse_file(&path).unwrap_err();

        assert!(matches!(error, ThreeMfError::Lib3Mf(_)), "{error:?}");
        assert!(
            !error.to_string().trim().is_empty(),
            "lib3mf error should include a message"
        );
    }

    #[test]
    fn canonical_exe_dir_normalizes_noncanonical_executable_path() {
        let temp = tempfile::tempdir().unwrap();
        let exe_dir = temp.path().join("bin");
        std::fs::create_dir_all(exe_dir.join("nested")).unwrap();
        let exe_path = exe_dir.join("model-core-test.exe");
        std::fs::write(&exe_path, b"test").unwrap();

        let noncanonical = exe_dir
            .join("nested")
            .join("..")
            .join("model-core-test.exe");
        let canonical_dir = canonical_exe_dir(&noncanonical).unwrap();

        assert_eq!(canonical_dir, exe_dir.canonicalize().unwrap());
        let bases = lib3mf_library_bases_from_exe_dir(&canonical_dir);
        assert_eq!(
            bases,
            vec![
                canonical_dir.join("lib3mf"),
                canonical_dir.join("libraries").join("lib3mf"),
            ]
        );
        assert!(bases.iter().all(|base| base.is_absolute()));
    }

    #[test]
    fn canonical_exe_dir_resolves_symlinked_executable_to_target_directory() {
        let temp = tempfile::tempdir().unwrap();
        let target_dir = temp.path().join("target-bin");
        let link_dir = temp.path().join("link-bin");
        std::fs::create_dir_all(&target_dir).unwrap();

        let target_exe = target_dir.join("model-core-test.exe");
        std::fs::write(&target_exe, b"test").unwrap();

        let symlink_exe = create_executable_alias(&target_dir, &link_dir, &target_exe);

        let canonical_dir = canonical_exe_dir(&symlink_exe).unwrap();
        let expected_dir = target_dir.canonicalize().unwrap();

        assert_ne!(
            symlink_exe.parent().unwrap(),
            target_dir,
            "test fixture must use a distinct alias spelling"
        );
        assert_eq!(canonical_dir, expected_dir);
    }

    #[cfg(windows)]
    fn create_executable_alias(target_dir: &Path, link_dir: &Path, target_exe: &Path) -> PathBuf {
        let output = Command::new("cmd.exe")
            .args(["/d", "/c", "mklink", "/J"])
            .arg(link_dir)
            .arg(target_dir)
            .output()
            .expect("create junction fixture");
        assert!(
            output.status.success(),
            "failed to create junction fixture: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        link_dir.join(target_exe.file_name().unwrap())
    }

    #[cfg(not(windows))]
    fn create_executable_alias(_target_dir: &Path, link_dir: &Path, target_exe: &Path) -> PathBuf {
        std::fs::create_dir_all(link_dir).unwrap();
        let symlink_exe = link_dir.join(target_exe.file_name().unwrap());
        create_file_symlink(target_exe, &symlink_exe).expect("create symlinked executable fixture");
        symlink_exe
    }

    #[test]
    fn curated_loader_tries_only_explicit_absolute_paths() {
        let bases = vec![
            PathBuf::from(r"C:\secure\lib3mf"),
            PathBuf::from(r"C:\secure\libraries\lib3mf"),
        ];
        let mut seen = Vec::new();

        let error = load_wrapper_from_library_bases::<(), _>(&bases, |candidate| {
            seen.push(candidate.to_path_buf());
            Err("missing test library".to_string())
        })
        .unwrap_err();

        assert_eq!(seen, bases);
        assert!(seen.iter().all(|candidate| candidate.is_absolute()));
        assert!(
            matches!(error, ThreeMfError::Lib3Mf(message) if message.contains("curated absolute paths"))
        );
        assert_eq!(seen.len(), bases.len());
    }

    #[test]
    fn curated_loader_rejects_non_absolute_paths() {
        let error =
            load_wrapper_from_library_bases::<(), _>(&[PathBuf::from("lib3mf")], |_| Ok(()))
                .unwrap_err();

        assert!(
            matches!(error, ThreeMfError::Lib3Mf(message) if message.contains("must be absolute"))
        );
    }

    #[test]
    fn pinned_lib3mf_revision_matches_manifest_pin() {
        let revision = pinned_lib3mf_revision();
        let artifact = pinned_lib3mf_artifact(lib3mf_library_extension()).unwrap();
        assert_eq!(
            extract_pinned_lib3mf_revision(MODEL_CORE_CARGO_TOML).unwrap(),
            revision
        );
        assert_eq!(artifact.revision, revision);
        assert_eq!(revision.len(), 40);
        assert!(revision.chars().all(|ch| ch.is_ascii_hexdigit()));
        assert_eq!(artifact.sha256.len(), 64);
        assert!(artifact
            .sha256
            .bytes()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f')));
    }

    #[test]
    fn stage_library_selection_rejects_mismatched_cached_checkout() {
        let temp = tempfile::tempdir().unwrap();
        let checkouts = temp.path().join("git").join("checkouts");
        let revision_dir = checkouts.join("lib3mf_rs-test").join("deadbee");
        std::fs::create_dir_all(revision_dir.join("libraries")).unwrap();
        std::fs::write(
            revision_dir
                .join("libraries")
                .join(format!("lib3mf.{}", lib3mf_library_extension())),
            b"fake",
        )
        .unwrap();

        let error = select_pinned_lib3mf_library(&checkouts, lib3mf_library_extension(), |_| {
            Ok("deadbeefdeadbeefdeadbeefdeadbeefdeadbeef".to_string())
        })
        .unwrap_err();

        assert!(error.contains("refusing to stage"));
        assert!(error.contains(pinned_lib3mf_revision()));
        assert!(error.contains("deadbeefdeadbeefdeadbeefdeadbeefdeadbeef"));
    }

    #[test]
    fn stage_library_selection_rejects_assume_unchanged_library_tampering() {
        let temp = tempfile::tempdir().unwrap();
        let checkouts = temp.path().join("git").join("checkouts");
        let revision_dir = checkouts.join("lib3mf_rs-test").join("deadbee");
        init_git_checkout_fixture(&revision_dir);
        let clean_head = git_stdout(&revision_dir, &["rev-parse", "HEAD"]);
        let library_path = revision_dir
            .join("libraries")
            .join(format!("lib3mf.{}", lib3mf_library_extension()));
        let clean_hash = crate::hash::hash_file(&library_path).unwrap();
        let repo_relative_library = Path::new("libraries")
            .join(format!("lib3mf.{}", lib3mf_library_extension()))
            .display()
            .to_string();

        git_success(
            &revision_dir,
            &["update-index", "--assume-unchanged", &repo_relative_library],
        );
        std::fs::write(&library_path, b"tampered-by-assume-unchanged\n").unwrap();

        let hidden_status = git_stdout(
            &revision_dir,
            &["status", "--porcelain", "--untracked-files=no"],
        );
        assert!(
            hidden_status.is_empty(),
            "assume-unchanged fixture should hide the tampered library from git status, got: {hidden_status}"
        );
        assert_eq!(
            verify_checkout_revision(&revision_dir).unwrap(),
            clean_head,
            "git-status-only revision verification should be bypassed by assume-unchanged in this fixture"
        );

        let artifact = PinnedLib3mfArtifact {
            revision: clean_head.clone(),
            extension: lib3mf_library_extension().to_string(),
            sha256: clean_hash.clone(),
        };
        let error = select_vetted_lib3mf_library(&checkouts, &artifact, verify_checkout_revision)
            .unwrap_err();

        assert!(error.contains("content hash"));
        assert!(error.contains(&clean_head));
        assert!(error.contains(&clean_hash));
        assert!(error.contains(&library_path.display().to_string()));
    }

    #[test]
    fn stage_library_stages_preopened_bytes_when_source_path_changes_after_open() {
        let temp = tempfile::tempdir().unwrap();
        let checkouts = temp.path().join("git").join("checkouts");
        let revision_dir = checkouts.join("lib3mf_rs-test").join("deadbee");
        init_git_checkout_fixture(&revision_dir);
        let library_path = revision_dir
            .join("libraries")
            .join(format!("lib3mf.{}", lib3mf_library_extension()));
        let original_bytes = b"original-safe-bytes\n";
        std::fs::write(&library_path, original_bytes).unwrap();
        git_success(&revision_dir, &["add", "."]);
        git_success(&revision_dir, &["commit", "-m", "refresh library"]);

        let clean_head = git_stdout(&revision_dir, &["rev-parse", "HEAD"]);
        let clean_hash = crate::hash::hash_file(&library_path).unwrap();
        let artifact = PinnedLib3mfArtifact {
            revision: clean_head,
            extension: lib3mf_library_extension().to_string(),
            sha256: clean_hash.clone(),
        };
        let staged = temp
            .path()
            .join("staged")
            .join(format!("lib3mf.{}", lib3mf_library_extension()));
        let swapped_bytes = b"tampered-after-open\n";

        let staged_hash = stage_vetted_lib3mf_library_with_hook(
            &checkouts,
            &staged,
            &artifact,
            verify_checkout_revision,
            |candidate| {
                let swapped_out = candidate.parent().unwrap().join(format!(
                    "lib3mf-opened-backup.{}",
                    lib3mf_library_extension()
                ));
                std::fs::rename(candidate, &swapped_out).map_err(|error| {
                    format!(
                        "failed to swap vetted source {} out from under the open handle: {error}",
                        candidate.display()
                    )
                })?;
                std::fs::write(candidate, swapped_bytes).map_err(|error| {
                    format!(
                        "failed to replace {} after swapping it out from under the open handle: {error}",
                        candidate.display()
                    )
                })?;
                Ok(())
            },
        )
        .unwrap();

        assert_eq!(staged_hash, clean_hash);
        assert_eq!(std::fs::read(&staged).unwrap(), original_bytes);
        assert_eq!(crate::hash::hash_file(&staged).unwrap(), clean_hash);
        assert_eq!(std::fs::read(&library_path).unwrap(), swapped_bytes);
    }

    #[cfg(windows)]
    #[test]
    fn verified_staged_library_handle_blocks_swap_until_load_finishes() {
        let temp = tempfile::tempdir().unwrap();
        let staged = temp
            .path()
            .join(format!("lib3mf.{}", lib3mf_library_extension()));
        std::fs::write(&staged, b"vetted\n").unwrap();
        let expected_hash = crate::hash::hash_file(&staged).unwrap();

        let load_guard = verify_staged_library_before_load(&staged, &expected_hash).unwrap();

        assert!(
            std::fs::rename(
                &staged,
                temp.path()
                    .join(format!("blocked.{}", lib3mf_library_extension())),
            )
            .is_err(),
            "verified staged handle should block path swaps until the load completes"
        );
        assert!(
            std::fs::write(&staged, b"tampered\n").is_err(),
            "verified staged handle should block in-place writes until the load completes"
        );

        drop(load_guard);
        std::fs::write(&staged, b"tampered\n").unwrap();
    }

    #[cfg(not(windows))]
    #[test]
    fn verified_staged_library_fd_path_reads_original_bytes_after_swap_without_helper_symlink() {
        let temp = tempfile::tempdir().unwrap();
        let staged = temp
            .path()
            .join(format!("lib3mf.{}", lib3mf_library_extension()));
        let original_bytes = b"vetted\n";
        let swapped_bytes = b"tampered\n";
        std::fs::write(&staged, original_bytes).unwrap();
        let expected_hash = crate::hash::hash_file(&staged).unwrap();
        let swapped_out = temp
            .path()
            .join(format!("original.{}", lib3mf_library_extension()));
        let initial_entries = vec![staged.file_name().unwrap().to_string_lossy().into_owned()];

        let observed_bytes = with_verified_staged_library_load_path(
            &staged,
            Some(&expected_hash),
            |load_path, _load_path_str| {
                assert_eq!(
                    temp_dir_entry_names(temp.path()),
                    initial_entries,
                    "verified non-Windows load should not materialize a helper path beside the staged library"
                );
                assert!(
                    is_verified_fd_path(load_path),
                    "expected direct fd path, got {}",
                    load_path.display()
                );
                assert_ne!(
                    load_path, staged,
                    "non-Windows loads must not reopen the staged pathname after final verification"
                );

                std::fs::rename(&staged, &swapped_out).map_err(|error| error.to_string())?;
                std::fs::write(&staged, swapped_bytes).map_err(|error| error.to_string())?;
                assert_eq!(
                    temp_dir_entry_names(temp.path()),
                    vec![
                        staged.file_name().unwrap().to_string_lossy().into_owned(),
                        swapped_out.file_name().unwrap().to_string_lossy().into_owned(),
                    ],
                    "only the staged file and swapped-out original should exist on disk during the verified load"
                );
                std::fs::read(load_path).map_err(|error| error.to_string())
            },
        )
        .unwrap();

        assert_eq!(observed_bytes, original_bytes);
        assert_eq!(std::fs::read(&staged).unwrap(), swapped_bytes);
        assert_eq!(std::fs::read(&swapped_out).unwrap(), original_bytes);
    }

    #[test]
    fn verify_checkout_revision_rejects_dirty_tracked_changes() {
        let temp = tempfile::tempdir().unwrap();
        let revision_dir = temp.path().join("lib3mf_rs-test").join("deadbee");
        init_git_checkout_fixture(&revision_dir);
        let clean_head = git_stdout(&revision_dir, &["rev-parse", "HEAD"]);

        std::fs::write(revision_dir.join("tracked.txt"), b"tampered\n").unwrap();

        let error = verify_checkout_revision(&revision_dir).unwrap_err();
        assert!(error.contains("tracked working tree changes"));
        assert!(error.contains("tracked.txt"));
        assert!(error.contains(&clean_head));
    }

    fn init_git_checkout_fixture(revision_dir: &Path) {
        std::fs::create_dir_all(revision_dir.join("libraries")).unwrap();
        git_success(revision_dir, &["init"]);
        git_success(revision_dir, &["config", "user.name", "Bishop Test"]);
        git_success(
            revision_dir,
            &["config", "user.email", "bishop@example.com"],
        );

        std::fs::write(
            revision_dir
                .join("libraries")
                .join(format!("lib3mf.{}", lib3mf_library_extension())),
            b"fake",
        )
        .unwrap();
        std::fs::write(revision_dir.join("tracked.txt"), b"clean\n").unwrap();

        git_success(revision_dir, &["add", "."]);
        git_success(revision_dir, &["commit", "-m", "fixture"]);
    }

    fn git_stdout(repo: &Path, args: &[&str]) -> String {
        let output = Command::new("git")
            .arg("-C")
            .arg(repo)
            .args(args)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "git {:?} failed for {}: {}",
            args,
            repo.display(),
            String::from_utf8_lossy(&output.stderr).trim()
        );
        String::from_utf8_lossy(&output.stdout).trim().to_string()
    }

    fn git_success(repo: &Path, args: &[&str]) {
        let output = Command::new("git")
            .arg("-C")
            .arg(repo)
            .args(args)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "git {:?} failed for {}: {}",
            args,
            repo.display(),
            String::from_utf8_lossy(&output.stderr).trim()
        );
    }

    #[cfg(windows)]
    #[test]
    fn hardened_windows_loader_sets_default_dirs_and_removes_added_directory() {
        use std::cell::RefCell;

        let directory = Path::new(r"C:\secure\libraries");
        let events = RefCell::new(Vec::new());

        let result = with_windows_added_dll_directory(
            directory,
            |path| {
                events.borrow_mut().push(format!("add:{}", path.display()));
                Ok(1usize as DllDirectoryCookie)
            },
            |cookie| {
                events.borrow_mut().push(format!("remove:{cookie:p}"));
                Ok(())
            },
            || {
                events.borrow_mut().push(format!(
                    "load-flags:{:#x}",
                    hardened_windows_dll_search_flags()
                ));
                Ok::<_, String>("loaded")
            },
        )
        .unwrap();

        assert_eq!(result, "loaded");
        assert_eq!(
            events.into_inner(),
            vec![
                format!("add:{}", directory.display()),
                format!("load-flags:{:#x}", hardened_windows_dll_search_flags()),
                format!("remove:{:p}", 1usize as DllDirectoryCookie),
            ]
        );
        assert_eq!(
            hardened_windows_dll_search_flags(),
            LOAD_LIBRARY_SEARCH_APPLICATION_DIR
                | LOAD_LIBRARY_SEARCH_SYSTEM32
                | LOAD_LIBRARY_SEARCH_USER_DIRS
        );
    }

    #[test]
    fn internal_parser_diagnostics_survive_native_validation() {
        // The internal parser resolves appearances; lib3mf does not, so its
        // findings exist only on `mesh`. `merge_validated_scene` used to assign
        // both fields, which meant enabling the stronger validator silently
        // erased the corruption diagnostics the weaker path had produced - the
        // same file reporting degraded with the feature off and clean with it
        // on. Combined, not replaced.
        let mut mesh = sample_mesh();
        mesh.status = SceneLoadStatus::Partial;
        mesh.status_messages
            .push("some appearance references could not be read".to_string());

        let mut validated = sample_mesh();
        validated.status = SceneLoadStatus::Complete;
        validated.status_messages = vec!["a native finding".to_string()];
        let mut guard = test_guard();

        merge_validated_scene(&mut mesh, validated, &mut guard).unwrap();

        assert_eq!(mesh.status, SceneLoadStatus::Partial);
        assert!(
            mesh.status_messages
                .iter()
                .any(|m| m.contains("could not be read")),
            "the internal finding must survive: {:?}",
            mesh.status_messages
        );
        assert!(
            mesh.status_messages.iter().any(|m| m == "a native finding"),
            "the native finding must still be reported: {:?}",
            mesh.status_messages
        );
    }

    #[test]
    fn merging_validated_messages_does_not_duplicate() {
        // Both paths can legitimately observe the same defect. Appending
        // unconditionally would let a hostile file grow the message list once
        // per validation pass, which is the amplification the flag-not-count
        // design elsewhere exists to prevent.
        let shared = "the same finding from both parsers".to_string();
        let mut mesh = sample_mesh();
        mesh.status_messages.push(shared.clone());
        let mut validated = sample_mesh();
        validated.status_messages = vec![
            shared.clone(),
            "native finding one".to_string(),
            "native finding two".to_string(),
            "native finding one".to_string(),
        ];
        let mut guard = test_guard();

        merge_validated_scene(&mut mesh, validated, &mut guard).unwrap();

        assert_eq!(
            mesh.status_messages,
            vec![
                shared,
                "native finding one".to_string(),
                "native finding two".to_string()
            ]
        );
    }

    #[test]
    fn validated_scene_merge_observes_the_parse_deadline() {
        let mut mesh = sample_mesh();
        let validated = sample_mesh();
        let mut guard =
            ParseGuard::new(ParseLimits::default().with_timeout(Duration::from_millis(1)));
        std::thread::sleep(Duration::from_millis(2));

        let error = merge_validated_scene(&mut mesh, validated, &mut guard)
            .expect_err("an expired parse deadline must stop the lib3mf merge");

        assert!(matches!(
            error,
            ThreeMfError::Limit(LimitViolation::Timeout { limit_ms: 1, .. })
        ));
    }

    #[test]
    fn merging_a_large_distinct_message_count_dedups_correctly_and_stays_fast() {
        // N is attacker-influenced (messages interpolate build-item and
        // resource ids), so the dedup must not be O(N^2) in the distinct
        // message count. This pins two properties at once: the *set* produced
        // is identical to a naive reference implementation (correctness), and
        // wall-clock time for a large N stays far below what a quadratic
        // `contains` scan would take (performance). A regression to
        // `Vec::contains`-based dedup would still pass the correctness half
        // here, which is why the elapsed-time assertion is load-bearing, not
        // decorative: 20_000 distinct messages is roughly 2*10^8 string
        // comparisons under O(N^2), which does not complete in the bound
        // below on any developer or CI machine, whereas the O(N) hash-set
        // path does the same work in low single-digit milliseconds.
        const DISTINCT: usize = 20_000;

        let mut mesh = sample_mesh();
        let mut validated = sample_mesh();
        // Every message appears twice (once from each synthetic "pass") so the
        // dedup has real duplicate work to do, not just N inserts into an
        // empty set.
        let mut expected = Vec::with_capacity(DISTINCT);
        let mut messages = Vec::with_capacity(DISTINCT * 2);
        for id in 0..DISTINCT {
            let message = format!("lib3mf: unresolved reference to resource id {id}");
            expected.push(message.clone());
            messages.push(message.clone());
            messages.push(message);
        }
        validated.status_messages = messages;
        let mut guard = test_guard();

        let started = Instant::now();
        merge_validated_scene(&mut mesh, validated, &mut guard).unwrap();
        let elapsed = started.elapsed();

        assert_eq!(
            mesh.status_messages, expected,
            "dedup must preserve first-seen order and drop every duplicate"
        );
        assert!(
            elapsed < Duration::from_secs(5),
            "merging {DISTINCT} distinct messages took {elapsed:?}; an O(N^2) \
             dedup would not finish this fast, so this points at a regression \
             to the linear `contains` scan"
        );
    }

    fn sample_mesh() -> ThreeMfMesh {
        ThreeMfMesh {
            vertices: vec![[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0]],
            triangles: vec![[0, 1, 2]],
            bounds: Aabb {
                min: [0.0, 0.0, 0.0],
                max: [1.0, 1.0, 0.0],
            },
            unit: "millimeter".to_string(),
            object_count: 1,
            build_item_count: 1,
            status: SceneLoadStatus::Complete,
            status_messages: Vec::new(),
            parts: vec![ThreeMfPart {
                name: "Object 1".to_string(),
                triangle_start: 0,
                triangle_count: 1,
                status: SceneLoadStatus::Complete,
                status_detail: None,
                part_number: None,
                material_label: None,
            }],
            objects: Vec::new(),
            root_object_ids: Vec::new(),
            plates: Vec::new(),
        }
    }

    fn fixture_path(name: &str) -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("tests")
            .join("fixtures")
            .join(name)
    }

    #[cfg(not(windows))]
    fn is_verified_fd_path(path: &Path) -> bool {
        let numeric_fd = path
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| !name.is_empty() && name.chars().all(|ch| ch.is_ascii_digit()));
        if !numeric_fd {
            return false;
        }

        #[cfg(target_os = "linux")]
        {
            path.starts_with(Path::new("/proc/self/fd"))
        }

        #[cfg(any(
            target_os = "macos",
            target_os = "freebsd",
            target_os = "dragonfly",
            target_os = "netbsd",
            target_os = "openbsd"
        ))]
        {
            path.starts_with(Path::new("/dev/fd"))
        }

        #[cfg(not(any(
            target_os = "linux",
            target_os = "macos",
            target_os = "freebsd",
            target_os = "dragonfly",
            target_os = "netbsd",
            target_os = "openbsd"
        )))]
        {
            false
        }
    }

    #[cfg(not(windows))]
    fn temp_dir_entry_names(path: &Path) -> Vec<String> {
        let mut entries = std::fs::read_dir(path)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        entries.sort();
        entries
    }
}
