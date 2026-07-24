use std::collections::{BTreeSet, HashMap};
use std::ffi::{CStr, CString};
use std::os::raw::c_char;
use std::path::{Path, PathBuf};
use std::ptr;

use lib3mf_ffi::{
    eModelUnit, eObjectType, sColor, sPosition, sTransform, sTriangle, sTriangleProperties, CBool,
    Lib3MF_Base, Lib3MF_BuildItem, Lib3MF_ComponentsObject, Lib3MF_MeshObject, Lib3MF_Model,
    Lib3MF_Object, Lib3MF_Reader, Wrapper,
};

use crate::geometry::Aabb;
use crate::scene_status::SceneLoadStatus;
use crate::threemf::{
    ThreeMfError, ThreeMfMesh, ThreeMfPart, MAX_COMPONENT_DEPTH, MAX_TRIANGLES, MAX_VERTICES,
};

pub fn parse_file(path: &Path) -> Result<ThreeMfMesh, ThreeMfError> {
    let mesh = crate::threemf::parse_file(path)?;
    Ok(match Lib3mfSession::new() {
        Ok(session) => merge_or_fallback(
            mesh,
            session.parse_file(path),
            NativeValidationFailureKind::ValidationFailed,
        ),
        Err(error) => merge_or_fallback(
            mesh,
            Err(error),
            NativeValidationFailureKind::ValidatorUnavailable,
        ),
    })
}

pub fn parse_bytes(data: &[u8]) -> Result<ThreeMfMesh, ThreeMfError> {
    let mesh = crate::threemf::parse_bytes(data)?;
    Ok(match Lib3mfSession::new() {
        Ok(session) => merge_or_fallback(
            mesh,
            session.parse_bytes(data),
            NativeValidationFailureKind::ValidationFailed,
        ),
        Err(error) => merge_or_fallback(
            mesh,
            Err(error),
            NativeValidationFailureKind::ValidatorUnavailable,
        ),
    })
}

struct Lib3mfSession {
    wrapper: Wrapper,
}

impl Lib3mfSession {
    fn new() -> Result<Self, ThreeMfError> {
        let bases = lib3mf_library_bases()?;
        let wrapper = load_wrapper_from_library_bases(&bases, |candidate| {
            Wrapper::new(Some(candidate)).map_err(|error| error.message)
        })?;
        Ok(Self { wrapper })
    }

    fn api(&self) -> &lib3mf_ffi::Api {
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
    api: &'a lib3mf_ffi::Api,
    raw: Lib3MF_Base,
}

impl<'a> OwnedHandle<'a> {
    fn new(api: &'a lib3mf_ffi::Api, raw: Lib3MF_Base) -> Self {
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
) -> ThreeMfMesh {
    match validated {
        Ok(validated) => {
            merge_validated_scene(&mut mesh, validated);
            mesh
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
            mesh
        }
    }
}

fn merge_validated_scene(mesh: &mut ThreeMfMesh, validated: ThreeMfMesh) {
    mesh.unit = validated.unit;
    mesh.object_count = validated.object_count;
    mesh.build_item_count = validated.build_item_count;
    mesh.status = validated.status;
    mesh.status_messages = validated.status_messages;

    for (part, validated_part) in mesh.parts.iter_mut().zip(validated.parts) {
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
    F: FnMut(&str) -> Result<T, String>,
{
    let mut attempts = Vec::new();
    for candidate in bases {
        if !candidate.is_absolute() {
            return Err(ThreeMfError::Lib3Mf(format!(
                "lib3mf search path must be absolute: {:?}",
                candidate
            )));
        }

        let candidate_str = candidate.to_str().ok_or_else(|| {
            ThreeMfError::Lib3Mf(format!(
                "lib3mf search path is not valid UTF-8: {:?}",
                candidate
            ))
        })?;

        match load(candidate_str) {
            Ok(wrapper) => return Ok(wrapper),
            Err(error) => attempts.push(format!("{candidate_str}: {error}")),
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::ErrorKind;
    use std::sync::OnceLock;

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

        let mesh = merge_or_fallback(
            mesh,
            Err(ThreeMfError::Lib3Mf(
                "failed to locate lib3mf shared library".to_string(),
            )),
            NativeValidationFailureKind::ValidatorUnavailable,
        );

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

        let mesh = merge_or_fallback(
            mesh,
            Err(ThreeMfError::Lib3Mf(
                "ReadFromBuffer failed: invalid resource reference".to_string(),
            )),
            NativeValidationFailureKind::ValidationFailed,
        );

        assert_eq!(mesh.status, SceneLoadStatus::Unsupported);
        assert!(mesh.status_messages.iter().any(|message| {
            message.contains("native lib3mf validation failed")
                && message.contains("invalid resource reference")
        }));
    }

    #[test]
    fn strict_native_parser_returns_lib3mf_error_for_invalid_namespace_fixture() {
        stage_test_library().unwrap();

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
        std::fs::create_dir_all(&link_dir).unwrap();

        let target_exe = target_dir.join("model-core-test.exe");
        std::fs::write(&target_exe, b"test").unwrap();

        let symlink_exe = link_dir.join("model-core-test.exe");
        if let Err(error) = create_file_symlink(&target_exe, &symlink_exe) {
            if should_skip_symlink_test(&error) {
                eprintln!(
                    "skipping symlink canonical_exe_dir test: insufficient privileges to create file symlink ({error})"
                );
                return;
            }
            panic!("failed to create symlinked executable fixture: {error}");
        }

        let canonical_dir = canonical_exe_dir(&symlink_exe).unwrap();
        let expected_dir = target_dir.canonicalize().unwrap();
        let symlink_parent = symlink_exe.parent().unwrap().canonicalize().unwrap();

        assert_ne!(
            expected_dir, symlink_parent,
            "test fixture must place the symlink in a different directory than its target"
        );
        assert_eq!(canonical_dir, expected_dir);
    }

    #[test]
    fn curated_loader_tries_only_explicit_absolute_paths() {
        let bases = vec![
            PathBuf::from(r"C:\secure\lib3mf"),
            PathBuf::from(r"C:\secure\libraries\lib3mf"),
        ];
        let mut seen = Vec::new();

        let error = load_wrapper_from_library_bases::<(), _>(&bases, |candidate| {
            seen.push(candidate.to_string());
            Err("missing test library".to_string())
        })
        .unwrap_err();

        assert_eq!(
            seen,
            bases
                .iter()
                .map(|candidate| candidate.to_string_lossy().into_owned())
                .collect::<Vec<_>>()
        );
        assert!(seen
            .iter()
            .all(|candidate| Path::new(candidate).is_absolute()));
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

    #[cfg(windows)]
    fn create_file_symlink(target: &Path, link: &Path) -> std::io::Result<()> {
        std::os::windows::fs::symlink_file(target, link)
    }

    #[cfg(unix)]
    fn create_file_symlink(target: &Path, link: &Path) -> std::io::Result<()> {
        std::os::unix::fs::symlink(target, link)
    }

    #[cfg(not(any(windows, unix)))]
    fn create_file_symlink(_target: &Path, _link: &Path) -> std::io::Result<()> {
        Err(std::io::Error::new(
            ErrorKind::Unsupported,
            "file symlinks are not supported on this platform",
        ))
    }

    fn should_skip_symlink_test(error: &std::io::Error) -> bool {
        matches!(error.kind(), ErrorKind::PermissionDenied)
            || cfg!(windows) && matches!(error.raw_os_error(), Some(1314))
    }

    fn stage_test_library() -> Result<(), String> {
        static STAGED: OnceLock<Result<(), String>> = OnceLock::new();
        STAGED.get_or_init(stage_test_library_once).clone()
    }

    fn stage_test_library_once() -> Result<(), String> {
        let extension = if cfg!(windows) {
            "dll"
        } else if cfg!(target_os = "macos") {
            "dylib"
        } else {
            "so"
        };
        let exe_dir = std::env::current_exe()
            .map_err(|error| format!("unable to locate test executable: {error}"))?
            .parent()
            .map(Path::to_path_buf)
            .ok_or_else(|| "test executable has no parent directory".to_string())?;
        let staged = exe_dir.join(format!("lib3mf.{extension}"));
        if staged.exists() {
            return Ok(());
        }

        let cargo_home = std::env::var_os("CARGO_HOME")
            .map(PathBuf::from)
            .or_else(|| {
                std::env::var_os("USERPROFILE").map(|profile| PathBuf::from(profile).join(".cargo"))
            })
            .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".cargo")))
            .ok_or_else(|| "unable to determine Cargo home for lib3mf test staging".to_string())?;
        let checkouts = cargo_home.join("git").join("checkouts");
        let source = std::fs::read_dir(&checkouts)
            .map_err(|error| format!("unable to read {checkouts:?}: {error}"))?
            .filter_map(Result::ok)
            .find_map(|entry| {
                let name = entry.file_name().to_string_lossy().to_ascii_lowercase();
                if !name.starts_with("lib3mf_rs-") {
                    return None;
                }
                std::fs::read_dir(entry.path())
                    .ok()?
                    .filter_map(Result::ok)
                    .map(|revision| {
                        revision
                            .path()
                            .join("libraries")
                            .join(format!("lib3mf.{extension}"))
                    })
                    .find(|candidate| candidate.is_file())
            })
            .ok_or_else(|| format!("unable to find lib3mf.{extension} under {checkouts:?}"))?;
        std::fs::copy(&source, &staged)
            .map_err(|error| format!("unable to stage {source:?} to {staged:?}: {error}"))?;
        Ok(())
    }
}
